import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolvePluginDirs, buildPluginDirArgs, executableNames } from './binary-resolver';

vi.mock('fs', () => {
  // binary-resolver.ts imports all six of these from 'fs'. The mock previously covered
  // only existsSync/readdirSync/statSync — with the whole suite silently never running
  // (see tests/setup.ts crypto fix), nothing ever caught that chmodSync/copyFileSync/
  // mkdirSync were missing, or that this factory needs a `default` export for Vitest's
  // ESM/CJS interop with built-in modules ("No 'default' export is defined on the 'fs'
  // mock").
  const mockFns = {
    existsSync: vi.fn(),
    readdirSync: vi.fn(),
    statSync: vi.fn(),
    chmodSync: vi.fn(),
    copyFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
  return { ...mockFns, default: mockFns };
});

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((name: string) => {
      if (name === 'userData') return '/tmp/test-user-data';
      return '/tmp/test';
    }),
    getAppPath: vi.fn(() => '/tmp/app'),
    isPackaged: false,
  },
  process: {
    resourcesPath: '/tmp/resources',
  },
}));

vi.mock('path', () => {
  const mockFns = {
    join: (...args: string[]) => args.join('/'),
    dirname: (p: string) => p.split('/').slice(0, -1).join('/') || '/',
    delimiter: process.platform === 'win32' ? ';' : ':',
  };
  return { ...mockFns, default: mockFns };
});

describe('binary-resolver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('executableNames', () => {
    it('returns .exe on Windows', () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      
      expect(executableNames('yt-dlp')).toEqual(['yt-dlp.exe', 'yt-dlp']);
      expect(executableNames('ffmpeg')).toEqual(['ffmpeg.exe', 'ffmpeg']);
      
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    });

    it('returns bare names on non-Windows', () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      
      expect(executableNames('yt-dlp')).toEqual(['yt-dlp']);
      expect(executableNames('ffmpeg')).toEqual(['ffmpeg']);
      
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    });
  });

  describe('resolvePluginDirs', () => {
    it('returns empty array when no plugin roots exist', async () => {
      const { existsSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(false);
      
      const dirs = resolvePluginDirs();
      expect(dirs).toEqual([]);
    });
  });

  describe('buildPluginDirArgs', () => {
    it('returns flat --plugin-dirs args for each resolved plugin dir', async () => {
      // buildPluginDirArgs calls resolvePluginDirs internally.
      // When no plugin roots exist (existsSync always false), it returns [].
      const { existsSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(false);
      const args = buildPluginDirArgs();
      expect(args).toEqual([]);
    });
  });
});