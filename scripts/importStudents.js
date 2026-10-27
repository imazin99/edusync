'use strict';

const path = require('path');

//57 students 
const ROSTER = [
  ['250100003', 'يوسف اشرف عبدالرازق ابراهيم'],
  ['250100006', 'نهى محمد زين العابدين احمد'],
  ['250100007', 'بيتر يعقوب انيس زكى'],
  ['250100013', 'عبدالرحمن ربيع عويس محمد'],
  ['250100015', 'يوسف ايهاب محمد عبد القوى'],
  ['250100018', 'عمر نبيل علي احمد'],
  ['250100020', 'مريم جمال سعيد الدربي'],
  ['250100023', 'الزهراء احمد ابراهيم احمد ابراهيم'],
  ['250100025', 'كيرلس مجدي سمير فريد'],
  ['250100027', 'شهد طه عبدهللا احمد'],
  ['250100029', 'الشيماء نزيه فاروق قرني'],
  ['250100030', 'شهيرة محمد عدالستار سعيد'],
  ['250100031', 'خديجة محمود محمد حسين'],
  ['250100033', 'زياد حسن عبدالمعبود محمد'],
  ['250100036', 'عبد الرحمن ناصر فتحي محمد'],
  ['250100037', 'اياد ايمن محمد عبده'],
  ['250100038', 'هدير عمر عكاشه اسماعيل'],
  ['250100040', 'مريم محمد وجيه امام'],
  ['250100041', 'دعاء فايز جابر جابر'],
  ['250100043', 'شهد علي محمد ابراهيم'],
  ['250100045', 'مصطفى مجدى عويس محمد'],
  ['250100046', 'سلمي مصطفي بكري حسين'],
  ['250100051', 'سارة جميل محمدين سيد'],
  ['250100056', 'مريم اشرف امين عزيز'],
  ['250100057', 'نورا عماد الدين يحي محمد'],
  ['250100060', 'ريهام البدوي سيد مروان'],
  ['250100061', 'مريم عطية وليم ميخائيل'],
  ['250100062', 'زياد جمال ابراهيم عبد اللطيف'],
  ['250100063', 'رضوى وسام وحيد الدين احمد'],
  ['250100067', 'اروى عيد عبدالحميد حميده'],
  ['250100068', 'نوران حسين عيد علي'],
  ['250100070', 'رضوى محمود سالم محمد'],
  ['250100072', 'محمد حسام جمعة عبدالنبي'],
  ['250100076', 'حبيبة طلعت محمد عبدالحليم'],
  ['250100077', 'موده محمد على احمد'],
  ['250100080', 'بسملة عريض عكاشة إسماعيل'],
  ['250100081', 'بسنت اسامه عويس محمد'],
  ['250100517', 'يوسف محمد ربيع جوده'],
  ['250100540', 'عمرو خالد سيد جنيدي'],
  ['250100543', 'شهد احمد معتمد محمد'],
  ['250100544', 'يارا احمد محمد محمد'],
  ['250100548', 'حبيبه اشرف محمد امين'],
  ['250100551', 'حسام جمال حبشى قرنى'],
  ['250100552', 'شهد حسنى محمد محمد'],
  ['250100562', 'حبيبة باسم فاروق محمود'],
  ['250100563', 'خالد حسين محمد احمد'],
  ['250100565', 'احمد سيد محمد يوسف'],
  ['250100567', 'محمد احمد اسماعيل عثمان'],
  ['250100572', 'بدر محمد صدقى محمد'],
  ['250100574', 'الشيماء عبدالعزيز عبدالتواب عبدالعزيز'],
  ['250100575', 'مازن احمد رجب متولى'],
  ['250100576', 'مهاب محمد عثمان بديع'],
  ['250100577', 'مريم محمود ابراهيم نظير'],
  ['250100578', 'رحمه حماده عبدالمنعم علي'],
  ['250100615', 'يوسف محمد جابر يسين'],
  ['250100642', 'عبدالرحمن عمر لطفي عويس'],
  ['250100654', 'اماني فوزي عبدالمنعم ابراهيم'],
];

const EXCLUDED_CODES = ['230100206', '240100646'];

async function detectTransactionSupport(mongoose) {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await mongoose.connection.db
        .collection('__import_tx_probe__')
        .findOne({}, { session });
    });
    return true;
  } catch (err) {
    const msg = err.message || '';
    if (
      msg.includes('replica set') ||
      msg.includes('Transaction numbers') ||
      msg.includes('not supported') ||
      msg.includes('standalone')
    ) {
      return false;
    }
    throw err; 
  } finally {
    await session.endSession();
  }
}

function buildTransactionRunner(mongoose) {
  return async function runInTransaction(callback) {
    const dbSession = await mongoose.startSession();
    try {
      let result;
      await dbSession.withTransaction(async () => {
        result = await callback(dbSession);
      });
      return result;
    } finally {
      await dbSession.endSession();
    }
  };
}

async function createStudentRecord({ studentCode, fullName, actorUser, models, auditService, runInTransaction }) {
  const { User, Student } = models;
  const code = studentCode.trim();
  const name = fullName.trim();

  const userDoc = {
    username: code,
    passwordHash: null,
    role: 'STUDENT',
    isActive: true,
  };
  const studentDoc = {
    studentCode: code,
    fullName: name,
    group: 'UNASSIGNED',
    isActive: true,
  };

  let createdStudent;

  if (runInTransaction) {
    let createdUser;
    await runInTransaction(async (session) => {
      const [user] = await User.create([userDoc], { session });
      createdUser = user;
      const [student] = await Student.create(
        [{ ...studentDoc, userId: user._id }],
        { session }
      );
      createdStudent = student;
    });
    await auditService.recordAudit({
      actorId: actorUser.id,
      actorRole: actorUser.role,
      action: 'STUDENT_CREATED',
      entityType: 'Student',
      entityId: createdStudent._id,
      after: { studentCode: code, fullName: name, group: 'UNASSIGNED' },
    });
  } else {
    const user = await User.create(userDoc);

    try {
      createdStudent = await Student.create({ ...studentDoc, userId: user._id });
    } catch (studentErr) {
      let deleteResult;
      try {
        deleteResult = await User.deleteOne({ _id: user._id });
      } catch (deleteErr) {
        const compensationErr = new Error(
          `Student.create failed AND compensating User.deleteOne threw an error. ` +
          `Orphaned User _id: ${user._id}. Manual cleanup required:\n` +
          `  mongosh academic_schedule --eval "db.users.deleteOne({_id: ObjectId('${user._id}')})"`,
        );
        compensationErr.orphanedUserId = String(user._id);
        compensationErr.originalError  = studentErr;
        compensationErr.deleteError    = deleteErr;
        throw compensationErr;
      }

      if (deleteResult.deletedCount !== 1) {
        throw studentErr;
      }
      throw studentErr;
    }

    await auditService.recordAudit({
      actorId: actorUser.id,
      actorRole: actorUser.role,
      action: 'STUDENT_CREATED',
      entityType: 'Student',
      entityId: createdStudent._id,
      after: { studentCode: code, fullName: name, group: 'UNASSIGNED' },
    });
  }

  return createdStudent;
}

module.exports = {
  ROSTER,
  EXCLUDED_CODES,
  createStudentRecord,
  detectTransactionSupport,
  buildTransactionRunner,
};

if (require.main === module) {
  require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
  const mongoose = require('mongoose');

  const MONGO_URI    = process.env.MONGODB_URI     || 'mongodb://127.0.0.1:27017/academic_schedule';
  const ADMIN_ID_STR = process.env.IMPORT_ADMIN_ID || '';

  async function main() {
    console.log('\n════════════════════════════════════════════════════════════');
    console.log('  EduSync — Student Roster Import');
    console.log('  Level 2 Medical Informatics, Beni Suef National University');
    console.log('════════════════════════════════════════════════════════════\n');

    if (!ADMIN_ID_STR || !mongoose.Types.ObjectId.isValid(ADMIN_ID_STR)) {
      console.error('❌  IMPORT_ADMIN_ID is required and must be a valid MongoDB ObjectId.');
      console.error('    Find it:');
      console.error('      mongosh academic_schedule --eval "db.users.findOne({role:\'ADMIN\'},{_id:1})"');
      console.error('    Then run:');
      console.error('      IMPORT_ADMIN_ID=<id> node scripts/importStudents.js\n');
      process.exit(1);
    }
    const actorUser = { id: ADMIN_ID_STR, role: 'ADMIN' };

    console.log(`Connecting to: ${MONGO_URI.replace(/\/\/([^:]+):([^@]+)@/, '//$1:****@')} ...`);
    try {
      await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 8000 });
    } catch (err) {
      console.error(`\n❌  CANNOT REACH MONGODB — ${err.message}`);
      process.exit(1);
    }
    console.log('✓  Connected.\n');

    const { User, Student }         = require('../server/models');
    const { createAuditService }    = require('../server/services/AuditService');
    const models       = { User, Student };
    const auditService = createAuditService();

    const adminUser = await User.findById(ADMIN_ID_STR).lean();
    if (!adminUser) {
      console.error(`❌  No User found with _id = ${ADMIN_ID_STR}.`);
      await mongoose.disconnect();
      process.exit(1);
    }
    if (adminUser.role !== 'ADMIN') {
      console.error(`❌  User ${ADMIN_ID_STR} has role "${adminUser.role}", not "ADMIN".`);
      await mongoose.disconnect();
      process.exit(1);
    }
    console.log(`✓  Import actor: ${adminUser.username} (ADMIN)\n`);

    let runInTransaction = null;
    try {
      const txSupported = await detectTransactionSupport(mongoose);
      if (txSupported) {
        runInTransaction = buildTransactionRunner(mongoose);
        console.log('✓  Replica-set detected — using TRANSACTION path (atomic per student).\n');
      } else {
        console.log('⚠  Standalone MongoDB — using COMPENSATING-DELETE path.\n');
      }
    } catch (err) {
      console.error(`❌  Transaction detection failed unexpectedly: ${err.message}`);
      await mongoose.disconnect();
      process.exit(1);
    }

    console.log('Running pre-flight conflict check...');
    const allCodes = ROSTER.map(([code]) => code);
    const [existingUsers, existingStudents] = await Promise.all([
      User.find({ username: { $in: allCodes } }, { username: 1 }).lean(),
      Student.find({ studentCode: { $in: allCodes } }, { studentCode: 1 }).lean(),
    ]);
    const existingUserCodes    = new Set(existingUsers.map(u => u.username));
    const existingStudentCodes = new Set(existingStudents.map(s => s.studentCode));

    const toCreate = [], toSkip = [], partialConflicts = [];

    for (const [code, name] of ROSTER) {
      const hasUser    = existingUserCodes.has(code);
      const hasStudent = existingStudentCodes.has(code);
      if (!hasUser && !hasStudent)    { toCreate.push([code, name]); }
      else if (hasUser && hasStudent) { toSkip.push({ code, name }); }
      else {
        partialConflicts.push({
          code, name,
          reason: hasUser
            ? 'User.username exists but no Student.studentCode (orphaned User)'
            : 'Student.studentCode exists but no User.username (orphaned Student)',
        });
      }
    }

    console.log(`  Eligible in roster : ${ROSTER.length}`);
    console.log(`  Already imported   : ${toSkip.length}  (will be skipped)`);
    console.log(`  Partial conflicts  : ${partialConflicts.length}`);
    console.log(`  To create          : ${toCreate.length}\n`);

    if (partialConflicts.length > 0) {
      console.error('❌  PARTIAL-STATE CONFLICTS — aborting. Inspect each manually:\n');
      for (const { code, name, reason } of partialConflicts) {
        console.error(`    ${code}  ${name}\n    → ${reason}\n`);
      }
      await mongoose.disconnect();
      process.exit(1);
    }

    if (toCreate.length === 0) {
      console.log('✓  All students already imported. Nothing to do.');
      await mongoose.disconnect();
      process.exit(0);
    }

    console.log(`━━━  Beginning import of ${toCreate.length} student(s) ━━━\n`);

    const results = { created: 0, failed: 0, errors: [] };
    const startTime = Date.now();

    for (let i = 0; i < toCreate.length; i++) {
      const [studentCode, fullName] = toCreate[i];
      const label = `[${String(i + 1).padStart(2, '0')}/${toCreate.length}] ${studentCode}`;
      try {
        await createStudentRecord({ studentCode, fullName, actorUser, models, auditService, runInTransaction });
        console.log(`  ✓  ${label}  ${fullName}`);
        results.created++;
      } catch (err) {
        console.error(`  ✗  ${label}  ${fullName}`);
        console.error(`       ${err.message}`);
        if (err.orphanedUserId) {
          console.error(`       ⚠  ORPHANED USER — manual cleanup required: db.users.deleteOne({_id: ObjectId("${err.orphanedUserId}")})`);
        }
        results.failed++;
        results.errors.push({ studentCode, fullName, message: err.message, orphanedUserId: err.orphanedUserId || null });
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log('\nRunning post-import orphan check...');
    const [finalUsers, finalStudents] = await Promise.all([
      User.find({ username: { $in: allCodes } }, { username: 1 }).lean(),
      Student.find({ studentCode: { $in: allCodes } }, { studentCode: 1 }).lean(),
    ]);
    const finalUserCodes    = new Set(finalUsers.map(u => u.username));
    const finalStudentCodes = new Set(finalStudents.map(s => s.studentCode));
    const orphanedUserCodes = [...finalUserCodes].filter(code => !finalStudentCodes.has(code));

    console.log('\n════════════════════════════════════════════════════════════');
    console.log('  IMPORT SUMMARY');
    console.log('════════════════════════════════════════════════════════════');
    console.log(`  Total eligible         : ${ROSTER.length}`);
    console.log(`  Skipped (pre-existing) : ${toSkip.length}`);
    console.log(`  Created successfully   : ${results.created}`);
    console.log(`  Failed                 : ${results.failed}`);
    console.log(`  Orphaned Users found   : ${orphanedUserCodes.length}`);
    console.log(`  Elapsed                : ${elapsed}s`);

    if (orphanedUserCodes.length > 0) {
      console.error('\n  ⚠  ORPHANED USERS (User exists, Student missing):');
      for (const code of orphanedUserCodes) {
        console.error(`    ${code}`);
        console.error(`    → db.users.deleteOne({username: "${code}"})`);
      }
    }
    if (results.errors.length > 0) {
      console.error('\n  FAILURES:');
      for (const { studentCode, fullName, message } of results.errors) {
        console.error(`    ${studentCode}  ${fullName}  →  ${message}`);
      }
    }

    const exitOk = results.failed === 0 && orphanedUserCodes.length === 0;
    console.log(exitOk
      ? '\n  ✓  Import completed cleanly — no errors, no orphans.'
      : '\n  ⚠  Import completed WITH ISSUES — review above before proceeding.');
    console.log('════════════════════════════════════════════════════════════\n');

    await mongoose.disconnect();
    process.exit(exitOk ? 0 : 1);
  }

  main().catch(err => {
    console.error('Unexpected fatal error:', err);
    process.exit(1);
  });
}
