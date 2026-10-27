/*
 *   Admin    — username: admin     password: DevAdmin123!
 *   Doctor   — username: doctor1   password: DevDoctor123!
 *   TA       — username: ta1       password: DevTA123!
 *   Leader   — username: leader1   password: DevLeader123! (MALE slot,
 *   Student  — code: STU0001       (no password — exercises the
 */

const { env } = require('../config/env');

if (env.isProduction) {
  console.error('[seed-dev-accounts] Refusing to run with NODE_ENV=production. Aborting.');
  process.exit(1);
}

const { connectDatabase, disconnectDatabase } = require('../config/database');
const { ROLES, STUDENT_GROUP_VALUES } = require('../utils/constants');
const models = require('../models');
const { User } = models;
const { hashPassword } = require('../utils/password');
const studentService = require('../services/StudentService');
const doctorService = require('../services/DoctorService');
const taService = require('../services/TAService');
const leaderService = require('../services/LeaderService');

const ACCOUNTS = {
  admin: { username: 'admin', password: 'DevAdmin123!' },
  doctor: { username: 'doctor1', password: 'DevDoctor123!', fullName: 'Dr. Dev Doctor' },
  ta: { username: 'ta1', password: 'DevTA123!', fullName: 'Dev TA' },
  leader: { username: 'leader1', password: 'DevLeader123!', fullName: 'Dev Leader' },
  student: { studentCode: 'STU0001', fullName: 'Dev Student', group: STUDENT_GROUP_VALUES[0] },
};

async function userExists(username) {
  return User.exists({ username });
}

async function seedAdmin() {
  if (await userExists(ACCOUNTS.admin.username)) {
    console.log(`  Admin "${ACCOUNTS.admin.username}" already exists — skipped.`);
    const existing = await User.findOne({ username: ACCOUNTS.admin.username });
    return existing;
  }
  const user = await User.create({
    username: ACCOUNTS.admin.username,
    passwordHash: await hashPassword(ACCOUNTS.admin.password),
    role: ROLES.ADMIN,
    isActive: true,
  });
  console.log(`  Created Admin "${ACCOUNTS.admin.username}".`);
  return user;
}

async function seedStudent(actorUser) {
  if (await userExists(ACCOUNTS.student.studentCode)) {
    console.log(`  Student "${ACCOUNTS.student.studentCode}" already exists — skipped.`);
    return;
  }
  await studentService.create({
    actorUser,
    studentCode: ACCOUNTS.student.studentCode,
    fullName: ACCOUNTS.student.fullName,
    group: ACCOUNTS.student.group,
  });
  console.log(`  Created Student "${ACCOUNTS.student.studentCode}" (no password, group ${ACCOUNTS.student.group}).`);
}

async function seedDoctor(actorUser) {
  if (await userExists(ACCOUNTS.doctor.username)) {
    console.log(`  Doctor "${ACCOUNTS.doctor.username}" already exists — skipped.`);
    return;
  }
  await doctorService.create({
    actorUser,
    username: ACCOUNTS.doctor.username,
    fullName: ACCOUNTS.doctor.fullName,
    password: ACCOUNTS.doctor.password,
  });
  console.log(`  Created Doctor "${ACCOUNTS.doctor.username}".`);
}

async function seedTA(actorUser) {
  if (await userExists(ACCOUNTS.ta.username)) {
    console.log(`  TA "${ACCOUNTS.ta.username}" already exists — skipped.`);
    return;
  }
  await taService.create({
    actorUser,
    username: ACCOUNTS.ta.username,
    fullName: ACCOUNTS.ta.fullName,
    password: ACCOUNTS.ta.password,
  });
  console.log(`  Created TA "${ACCOUNTS.ta.username}".`);
}

async function seedLeader(actorUser) {
  if (await userExists(ACCOUNTS.leader.username)) {
    console.log(`  Leader "${ACCOUNTS.leader.username}" already exists — skipped.`);
    return;
  }
  const student = await models.Student.findOne({ studentCode: ACCOUNTS.student.studentCode });
  if (!student) {
    console.log(
      `  Skipped Leader "${ACCOUNTS.leader.username}" — the seed Student "${ACCOUNTS.student.studentCode}" was not found (unexpected; it should have been created just above).`
    );
    return;
  }
  await leaderService.create({
    actorUser,
    slot: 'MALE',
    linkedStudentId: student._id,
    username: ACCOUNTS.leader.username,
    password: ACCOUNTS.leader.password,
  });
  console.log(`  Created Leader "${ACCOUNTS.leader.username}" (MALE slot, linked to ${ACCOUNTS.student.studentCode}).`);
}

async function main() {
  console.log('[seed-dev-accounts] Connecting to MongoDB...');
  await connectDatabase();

  console.log('[seed-dev-accounts] Seeding one account per role...');
  const adminUser = await seedAdmin();
  const actorUser = { id: adminUser._id.toString(), role: ROLES.ADMIN };

  await seedStudent(actorUser);
  await seedDoctor(actorUser);
  await seedTA(actorUser);
  await seedLeader(actorUser); // after Student — needs its _id

  console.log('');
  console.log('[seed-dev-accounts] Done. Sign in at /pages/login.html with:');
  console.log('');
  console.log('  Role     Identifier   Password');
  console.log('  -------  -----------  ----------------');
  console.log(`  Admin    ${ACCOUNTS.admin.username.padEnd(12)} ${ACCOUNTS.admin.password}`);
  console.log(`  Doctor   ${ACCOUNTS.doctor.username.padEnd(12)} ${ACCOUNTS.doctor.password}`);
  console.log(`  TA       ${ACCOUNTS.ta.username.padEnd(12)} ${ACCOUNTS.ta.password}`);
  console.log(`  Leader   ${ACCOUNTS.leader.username.padEnd(12)} ${ACCOUNTS.leader.password}`);
  console.log(`  Student  ${ACCOUNTS.student.studentCode.padEnd(12)} (leave blank — no password set)`);
  console.log('');

  await disconnectDatabase();
}

main().catch((err) => {
  console.error('[seed-dev-accounts] Failed:', err);
  process.exitCode = 1;
});
