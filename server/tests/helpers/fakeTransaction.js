function createFakeTransactionRunner(fakeModels) {
  return async function runInTransaction(callback) {
    const snapshots = [];
    for (const model of Object.values(fakeModels)) {
      if (model && Array.isArray(model._docs)) {
        snapshots.push({
          model,
          originalDocs: model._docs.slice(),
          fieldSnapshots: model._docs.map((d) => ({ ...d })),
        });
      }
    }

    try {
      const fakeDbSession = { __fakeTransactionSession: true };
      return await callback(fakeDbSession);
    } catch (err) {
      for (const { model, originalDocs, fieldSnapshots } of snapshots) {
        originalDocs.forEach((doc, i) => {
          const snapshot = fieldSnapshots[i];
          for (const key of Object.keys(doc)) {
            if (!(key in snapshot)) delete doc[key];
          }
          Object.assign(doc, snapshot);
        });
        model._docs.length = 0;
        model._docs.push(...originalDocs);
      }
      throw err;
    }
  };
}

module.exports = { createFakeTransactionRunner };
