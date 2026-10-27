function createTestFixtureScope() {
  const countersByPrefix = {};
  return {
    nextId(prefix) {
      countersByPrefix[prefix] = (countersByPrefix[prefix] || 0) + 1;
      return `${prefix}_${countersByPrefix[prefix]}`;
    },
  };
}

const FAKE_TIME_OF_DAY_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;

function attachSave(doc) {
  if (!doc.save) {
    Object.defineProperty(doc, 'save', {
      value: async function save() {
        return doc;
      },
      enumerable: false,
      configurable: true,
    });
  }

  if (doc.current && typeof doc.current === 'object' && !doc.current.toObject) {
    Object.defineProperty(doc.current, 'toObject', {
      value: function toObject() {
        return { ...doc.current };
      },
      enumerable: false,
      configurable: true,
    });
  }
  if (doc.current && typeof doc.current === 'object' && !doc.validate) {
    Object.defineProperty(doc, 'validate', {
      value: async function validate() {
        const { startTime, endTime, roomId, doctorId } = doc.current;
        const errors = [];
        if (!startTime || !FAKE_TIME_OF_DAY_REGEX.test(startTime)) {
          errors.push('current.startTime must be in HH:mm 24-hour format');
        }
        if (!endTime || !FAKE_TIME_OF_DAY_REGEX.test(endTime)) {
          errors.push('current.endTime must be in HH:mm 24-hour format');
        }
        if (startTime && endTime && !(endTime > startTime)) {
          errors.push('current.endTime must be later than current.startTime');
        }
        if (!roomId) errors.push('current.roomId is required');
        if (!doctorId) errors.push('current.doctorId is required');
        if (errors.length > 0) {
          const err = new Error(errors.join('; '));
          err.name = 'ValidationError';
          err.errors = errors;
          throw err;
        }
        return doc;
      },
      enumerable: false,
      configurable: true,
    });
  }
  return doc;
}

function readSortPath(doc, path) {
  return path.split('.').reduce((value, key) => (value == null ? undefined : value[key]), doc);
}

function compareBySpec(a, b, spec) {
  for (const [path, dir] of Object.entries(spec)) {
    let av = readSortPath(a, path);
    let bv = readSortPath(b, path);
    if (av instanceof Date) av = av.getTime();
    if (bv instanceof Date) bv = bv.getTime();
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
  }
  return 0;
}

function fakeQuery(resultPromise) {
  return {
    select: () => fakeQuery(resultPromise),
    sort: (spec) =>
      fakeQuery(
        resultPromise.then((docs) =>
          spec && Array.isArray(docs) ? [...docs].sort((a, b) => compareBySpec(a, b, spec)) : docs
        )
      ),
    session: () => fakeQuery(resultPromise),
    then: (onResolve, onReject) => resultPromise.then(onResolve, onReject),
    catch: (onReject) => resultPromise.catch(onReject),
  };
}

function valueMatches(docValue, condition) {
  if (condition instanceof RegExp) {
    return typeof docValue === 'string' && condition.test(docValue);
  }
  if (condition && typeof condition === 'object' && !Array.isArray(condition)) {
    const operatorKeys = ['$in', '$ne', '$lte'].filter((op) => op in condition);
    if (operatorKeys.length > 0) {
      return operatorKeys.every((op) => {
        if (op === '$in') {
          const set = condition.$in.map((v) => (v && v.toString ? v.toString() : v));
          return set.includes(docValue && docValue.toString ? docValue.toString() : docValue);
        }
        if (op === '$ne') {
          return !valueMatches(docValue, condition.$ne);
        }
        // $lte
        if (docValue === null || docValue === undefined) return false;
        return new Date(docValue).getTime() <= new Date(condition.$lte).getTime();
      });
    }
  }
  if (condition && typeof condition === 'object' && typeof condition.toString === 'function' && docValue) {
    return docValue.toString() === condition.toString();
  }
  if (condition === null) {
    return docValue === null || docValue === undefined;
  }
  return docValue === condition;
}

function matchesFilter(doc, filter) {
  return Object.entries(filter).every(([key, condition]) => {
    if (key === '$or') {
      return condition.some((sub) => matchesFilter(doc, sub));
    }
    return valueMatches(doc[key], condition);
  });
}

function createFakeCollection(prefix, seedDocs = [], scope) {
  const idScope = scope || createTestFixtureScope();
  const docs = seedDocs.map((d) => attachSave({ ...d, _id: d._id || idScope.nextId(prefix) }));

  function makeDoc(data) {
    const stamped = { ...data };
    if (stamped.createdAt === undefined) stamped.createdAt = new Date();
    if (stamped.updatedAt === undefined) stamped.updatedAt = new Date();
    return attachSave({ _id: idScope.nextId(prefix), ...stamped });
  }

  return {
    _docs: docs,
    findOne(filter = {}) {
      return fakeQuery(
        (async () => {
          const found = docs.find((d) => matchesFilter(d, filter));
          return found ? attachSave(found) : null;
        })()
      );
    },
    findById(id) {
      return fakeQuery(
        (async () => {
          const found = docs.find((d) => d._id.toString() === String(id));
          return found ? attachSave(found) : null;
        })()
      );
    },
    find(filter = {}) {
      return fakeQuery(
        (async () => docs.filter((d) => matchesFilter(d, filter)).map(attachSave))()
      );
    },
    exists(filter = {}) {
      return fakeQuery(
        (async () => {
          const found = docs.find((d) => matchesFilter(d, filter));
          return found ? { _id: found._id } : null;
        })()
      );
    },
    async deleteOne(filter = {}) {
      const idx = docs.findIndex((d) => matchesFilter(d, filter));
      if (idx >= 0) docs.splice(idx, 1);
      return { deletedCount: idx >= 0 ? 1 : 0 };
    },
    async create(data) {
      if (Array.isArray(data)) {
        const created = data.map((d) => {
          const doc = makeDoc(d);
          docs.push(doc);
          return doc;
        });
        return created;
      }
      const doc = makeDoc(data);
      docs.push(doc);
      return doc;
    },
    async updateOne(filter = {}, update = {},  _options = {}) {
      const doc = docs.find((d) => matchesFilter(d, filter));
      if (!doc) return { matchedCount: 0, modifiedCount: 0 };
      const setOps = (update && update.$set) || {};
      for (const [path, value] of Object.entries(setOps)) {
        const dotIndex = path.indexOf('.');
        if (dotIndex === -1) {
          doc[path] = value;
        } else {
          const topKey = path.slice(0, dotIndex);
          const subKey = path.slice(dotIndex + 1);
          if (!doc[topKey] || typeof doc[topKey] !== 'object') doc[topKey] = {};
          doc[topKey][subKey] = value;
        }
      }
      attachSave(doc);
      return { matchedCount: 1, modifiedCount: 1 };
    },
  };
}

module.exports = { createFakeCollection, createTestFixtureScope, attachSave };
