const test = require('node:test');
const assert = require('node:assert/strict');

const data = require('../src/data');

const {
  parseWslDistroList,
  getWslDistroList,
  getRunningWslDistroSet,
  filterWslDistrosForProcessScan,
  buildWslUncPath,
  normalizeProjectPath,
  shortenHomePath,
  detectWindowsWslHomes,
} = data.__test;

test('parseWslDistroList decodes UTF-16LE output and strips BOM/nulls', () => {
  const raw = Buffer.from('\uFEFFUbuntu-24.04\r\ndocker-desktop\r\n', 'utf16le');
  assert.deepEqual(parseWslDistroList(raw), ['Ubuntu-24.04', 'docker-desktop']);
  assert.deepEqual(parseWslDistroList('\uFEFFUbuntu\0-24.04\r\ndocker\0-desktop\r\n'), ['Ubuntu-24.04', 'docker-desktop']);
});

test('WSL list helpers fail safely when WSL is unavailable', () => {
  assert.deepEqual(getWslDistroList(() => { throw new Error('ENOENT'); }), []);
  assert.equal(getRunningWslDistroSet(() => { throw new Error('disabled'); }), null);
});

test('running distro filter keeps only running distros when available', () => {
  const running = getRunningWslDistroSet(() => Buffer.from('\uFEFFUbuntu-24.04\r\ndebian\r\n', 'utf16le'));
  assert.deepEqual(Array.from(running).sort(), ['Ubuntu-24.04', 'debian']);
  assert.deepEqual(
    filterWslDistrosForProcessScan(['Ubuntu-24.04', 'docker-desktop', 'debian'], running),
    ['Ubuntu-24.04', 'debian']
  );
  assert.deepEqual(filterWslDistrosForProcessScan(['Ubuntu-24.04'], null), []);
});

test('buildWslUncPath and shortenHomePath normalize WSL-visible paths', () => {
  assert.equal(buildWslUncPath('Ubuntu-24.04', '/home/dius'), '\\\\wsl$\\Ubuntu-24.04\\home\\dius');
  assert.equal(buildWslUncPath('Ubuntu-24.04', '/'), '\\\\wsl$\\Ubuntu-24.04\\');
  assert.equal(buildWslUncPath('', '/home/dius'), '');
  assert.equal(buildWslUncPath('Ubuntu-24.04', 'home/dius'), '');
  assert.equal(shortenHomePath('/home/dius/projects/codedash', ['\\\\wsl$\\Ubuntu-24.04\\home\\dius']), '~/projects/codedash');
  assert.equal(shortenHomePath('\\\\wsl$\\Ubuntu-24.04\\home\\dius\\projects\\codedash', ['\\\\wsl$\\Ubuntu-24.04\\home\\dius']), '~\\projects\\codedash');
  assert.equal(normalizeProjectPath('\\\\?\\C:\\Projects\\codedash'), 'C:\\Projects\\codedash');
});

test('detectWindowsWslHomes discovers only running distros with supported agent data', () => {
  const existing = new Set([
    '\\\\wsl$\\Ubuntu-24.04\\home\\dius\\.codex',
    '\\\\wsl$\\Debian\\home\\tester\\.cursor',
  ]);
  const mockFs = { existsSync: (candidate) => existing.has(candidate) };
  const distros = ['Ubuntu-24.04', 'Debian', 'Stopped'];
  const running = new Set(['Ubuntu-24.04', 'Debian']);
  const homeByDistro = {
    'Ubuntu-24.04': '/home/dius',
    Debian: '/home/tester',
    Stopped: '/home/stopped',
  };
  const execFileSyncImpl = (_exe, args) => {
    const distro = args[1];
    return homeByDistro[distro];
  };

  const homes = detectWindowsWslHomes({
    platform: 'win32',
    execFileSyncImpl,
    fsImpl: mockFs,
    getDistroList: () => distros,
    getRunningDistroSet: () => running,
  });

  assert.deepEqual(homes, [
    '\\\\wsl$\\Ubuntu-24.04\\home\\dius',
    '\\\\wsl$\\Debian\\home\\tester',
  ]);
});

test('detectWindowsWslHomes returns empty on non-Windows and does not throw for empty distro lists', () => {
  assert.deepEqual(detectWindowsWslHomes({ platform: 'linux' }), []);
  assert.deepEqual(detectWindowsWslHomes({
    platform: 'win32',
    execFileSyncImpl: () => { throw new Error('should not execute'); },
    fsImpl: { existsSync: () => false },
    getDistroList: () => [],
    getRunningDistroSet: () => new Set(),
  }), []);
});
