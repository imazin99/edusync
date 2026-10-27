const { env } = require('../config/env');
const mongoose = require('mongoose');
const { connectDatabase, disconnectDatabase } = require('../config/database');
function enforceReadOnlyModels() {
  const blocked = (name) =>
    function blockedWrite() {
      throw new Error(
        `[inspect-schedule-data] Refusing to run "${name}" — this script is read-only. ` +
          'If you need to write data, use the dedicated seed script instead.'
      );
    };

  const staticWriteMethods = [
    'create',
    'insertMany',
    'updateOne',
    'updateMany',
    'deleteOne',
    'deleteMany',
    'findOneAndUpdate',
    'findOneAndDelete',
    'findOneAndReplace',
    'findByIdAndUpdate',
    'findByIdAndDelete',
    'replaceOne',
    'bulkWrite',
  ];
  for (const method of staticWriteMethods) {
    if (typeof mongoose.Model[method] === 'function') {
      mongoose.Model[method] = blocked(`Model.${method}()`);
    }
  }

  const instanceWriteMethods = ['save', 'remove', 'deleteOne', 'updateOne', 'replaceOne'];
  for (const method of instanceWriteMethods) {
    if (typeof mongoose.Model.prototype[method] === 'function') {
      mongoose.Model.prototype[method] = blocked(`<document>.${method}()`);
    }
  }
}
async function reportSubjects(models) {
  const subjects = await models.Subject.find({}).lean();
  return {
    count: subjects.length,
    items: subjects.map((s) => ({
      id: String(s._id),
      name: s.name,
      code: s.code,
      hasSections: !!s.hasSections,
      isActive: s.isActive !== false,
      doctorId: s.doctorId ? String(s.doctorId) : null,
      taId: s.taId ? String(s.taId) : null,
    })),
  };
}

async function reportStaff(Model) {
  const docs = await Model.find({}).lean();
  return {
    count: docs.length,
    items: docs.map((d) => ({
      id: String(d._id),
      fullName: d.fullName,
      isActive: d.isActive !== false,
      userId: d.userId ? String(d.userId) : null,
    })),
  };
}

async function reportRooms(models) {
  const rooms = await models.Room.find({}).lean();
  return {
    count: rooms.length,
    items: rooms.map((r) => ({
      id: String(r._id),
      building: r.building,
      floor: r.floor,
      roomNumber: r.roomNumber,
      isActive: r.isActive !== false,
    })),
  };
}

async function reportTemplates(models) {
  const templates = await models.ScheduleTemplate.find({}).lean();
  const subjectsById = new Map((await models.Subject.find({}).lean()).map((s) => [String(s._id), s]));
  const roomsById = new Map((await models.Room.find({}).lean()).map((r) => [String(r._id), r]));
  const doctorsById = new Map((await models.Doctor.find({}).lean()).map((d) => [String(d._id), d]));
  const tasById = new Map((await models.TA.find({}).lean()).map((t) => [String(t._id), t]));

  return {
    count: templates.length,
    items: templates.map((t) => {
      const subject = subjectsById.get(String(t.subjectId));
      const room = roomsById.get(String(t.roomId));
      const doctor = doctorsById.get(String(t.doctorId));
      const ta = t.taId ? tasById.get(String(t.taId)) : null;
      return {
        id: String(t._id),
        subject: subject ? `${subject.name} (${subject.code})` : `UNKNOWN subjectId ${t.subjectId}`,
        type: t.type,
        group: t.group,
        dayOfWeek: t.dayOfWeek,
        startTime: t.startTime,
        endTime: t.endTime,
        room: room ? `${room.building}/${room.floor}/${room.roomNumber}` : `UNKNOWN roomId ${t.roomId}`,
        doctor: doctor ? doctor.fullName : `UNKNOWN doctorId ${t.doctorId}`,
        ta: ta ? ta.fullName : t.taId ? `UNKNOWN taId ${t.taId}` : null,
        effectiveFrom: t.effectiveFrom,
        effectiveTo: t.effectiveTo,
        isActive: !!t.isActive,
      };
    }),
  };
}

async function reportSessions(models) {
  const sessions = await models.ScheduleSession.find({}).lean();
  const byTemplate = new Map();
  for (const s of sessions) {
    const key = String(s.templateId);
    byTemplate.set(key, (byTemplate.get(key) || 0) + 1);
  }
  return {
    count: sessions.length,
    dateRange:
      sessions.length > 0
        ? {
            earliest: sessions.reduce((min, s) => (s.date < min ? s.date : min), sessions[0].date),
            latest: sessions.reduce((max, s) => (s.date > max ? s.date : max), sessions[0].date),
          }
        : null,
    sessionsPerTemplate: Object.fromEntries(byTemplate),
  };
}

async function reportChanges(models) {
  const changes = await models.ScheduleChange.find({}).lean();
  return {
    count: changes.length,
    permanentCount: changes.filter((c) => c.isPermanent).length,
    oneTimeCount: changes.filter((c) => !c.isPermanent).length,
  };
}
const OFFICIAL_TIMETABLE_SIGNATURE = [
  { subjectName: 'Data Communications', type: 'SECTION', dayOfWeek: 'SUNDAY', startTime: '09:00' },
  { subjectName: 'Human Pathology', type: 'SECTION', dayOfWeek: 'SUNDAY', startTime: '13:00' },
  { subjectName: 'Mathematics III', type: 'SECTION', dayOfWeek: 'MONDAY', startTime: '11:00' },
  { subjectName: 'Data Communications', type: 'LECTURE', dayOfWeek: 'TUESDAY', startTime: '09:00' },
  { subjectName: 'Object-Oriented Programming', type: 'SECTION', dayOfWeek: 'TUESDAY', startTime: '11:00' }, // image says "lab" — see Step 1 report
  { subjectName: 'System Analysis and Design', type: 'LECTURE', dayOfWeek: 'TUESDAY', startTime: '13:00' },
  { subjectName: 'Database fundamentals', type: 'LECTURE', dayOfWeek: 'TUESDAY', startTime: '15:00' },
  { subjectName: 'System Analysis and Design', type: 'SECTION', dayOfWeek: 'WEDNESDAY', startTime: '09:00' },
  { subjectName: 'Database fundamentals', type: 'SECTION', dayOfWeek: 'WEDNESDAY', startTime: '11:00' }, // image says "lab"
  { subjectName: 'Mathematics III', type: 'LECTURE', dayOfWeek: 'WEDNESDAY', startTime: '13:00' },
  { subjectName: 'Human Pathology', type: 'LECTURE', dayOfWeek: 'THURSDAY', startTime: '11:00' },
  { subjectName: 'Object-Oriented Programming', type: 'LECTURE', dayOfWeek: 'THURSDAY', startTime: '15:00' },
];

function crossCheckAgainstOfficialTimetable(templateItems) {
  return OFFICIAL_TIMETABLE_SIGNATURE.map((wanted) => {
    const matches = templateItems.filter(
      (t) =>
        t.subject.toLowerCase().includes(wanted.subjectName.toLowerCase()) &&
        t.type === wanted.type &&
        t.dayOfWeek === wanted.dayOfWeek &&
        t.startTime === wanted.startTime
    );
    return {
      wanted: `${wanted.subjectName} / ${wanted.type} / ${wanted.dayOfWeek} ${wanted.startTime}`,
      status: matches.length > 0 ? 'POSSIBLE MATCH FOUND' : 'NO MATCH FOUND',
      matchingTemplateIds: matches.map((m) => m.id),
    };
  });
}

async function main() {
  console.log('[inspect-schedule-data] Connecting to MongoDB...');
  await connectDatabase();
  enforceReadOnlyModels();
  console.log('[inspect-schedule-data] Connected. Read-only guard active. Running report...\n');

  const models = require('../models');

  const [subjects, doctors, tas, rooms, templates, sessions, changes] = await Promise.all([
    reportSubjects(models),
    reportStaff(models.Doctor),
    reportStaff(models.TA),
    reportRooms(models),
    reportTemplates(models),
    reportSessions(models),
    reportChanges(models),
  ]);

  const crossCheck = crossCheckAgainstOfficialTimetable(templates.items);

  const report = {
    generatedAt: new Date().toISOString(),
    environment: env.nodeEnv,
    counts: {
      subjects: subjects.count,
      doctors: doctors.count,
      tas: tas.count,
      rooms: rooms.count,
      scheduleTemplates: templates.count,
      scheduleSessions: sessions.count,
      scheduleChanges: changes.count,
    },
    subjects: subjects.items,
    doctors: doctors.items,
    tas: tas.items,
    rooms: rooms.items,
    scheduleTemplates: templates.items,
    scheduleSessions: {
      count: sessions.count,
      dateRange: sessions.dateRange,
      sessionsPerTemplate: sessions.sessionsPerTemplate,
    },
    scheduleChanges: {
      count: changes.count,
      permanentCount: changes.permanentCount,
      oneTimeCount: changes.oneTimeCount,
    },
    officialTimetableCrossCheck: {
      note:
        'Each row below is a slot from the Step 1 timetable extraction, checked against existing ' +
        'ScheduleTemplates by subject-name substring + type + dayOfWeek + startTime. "POSSIBLE MATCH ' +
        'FOUND" means a template with all four of those lines up — it is NOT a guarantee the room/doctor/ta ' +
        'also match, and "NO MATCH FOUND" does not by itself mean the entry is missing from the database ' +
        'under a different subject-name spelling. This is a cross-check aid for the seeding step, not a ' +
        'final classification — nothing here is labeled "official" or "demo" without this explicit basis.',
      results: crossCheck,
    },
  };

  console.log(JSON.stringify(report, null, 2));

  await disconnectDatabase();
}

main().catch((err) => {
  console.error('[inspect-schedule-data] Failed:', err.message);
  process.exitCode = 1;
});
