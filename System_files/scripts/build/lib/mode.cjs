// System_files/scripts/build/lib/mode.cjs
function getMode() {
  const raw = (process.env.SCHEDULE_MODE || 'test').toLowerCase();
  if (raw === 'live' || raw === 'prod') return 'live';
  return 'test';
}

function isTest() {
  return getMode() === 'test';
}

function isLive() {
  return getMode() === 'live';
}

module.exports = { getMode, isTest, isLive };
