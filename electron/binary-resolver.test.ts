import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolvePluginDirs, buildPluginDirArgs, executableNames, getBinaryStatus } from './binary-resolver';

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

    // Regression: every bundled plugin was inert in every shipped build.
    // resolvePluginDirs expanded each root into its individual package folders,
    // on the untested assumption that --plugin-dirs wants a directory directly
    // containing yt_dlp_plugins/. yt-dlp globs <dir>/*/yt_dlp_plugins itself, so
    // being handed the package directory it found nothing and said so quietly:
    //   --plugin-dirs plugins/anikoto -> "Plugin directories: none", 1744 extractors
    //   --plugin-dirs plugins         -> five packages resolved, 1750 extractors
    it('hands yt-dlp the root, not each package inside it', async () => {
      const { existsSync, readdirSync, statSync } = await import('fs');
      vi.mocked(existsSync).mockImplementation((p) => {
        const path = String(p);
        // The roots exist, and each package inside them has a yt_dlp_plugins/.
        if (path.endsWith('/plugins')) return true;
        return path.includes('/plugins/') && path.endsWith('yt_dlp_plugins');
      });
      vi.mocked(readdirSync).mockReturnValue(['anikoto', 'animepahe'] as never);
      vi.mocked(statSync).mockReturnValue({ isDirectory: () => true } as never);

      const dirs = resolvePluginDirs();

      expect(dirs.length).toBeGreaterThan(0);
      for (const dir of dirs) {
        expect(dir.endsWith('plugins')).toBe(true);
        expect(dir).not.toContain('anikoto');
        expect(dir).not.toContain('animepahe');
      }
    });

    it('skips a root that holds no plugin package at all', async () => {
      const { existsSync, readdirSync, statSync } = await import('fs');
      vi.mocked(existsSync).mockImplementation((p) => String(p).endsWith('/plugins'));
      vi.mocked(readdirSync).mockReturnValue(['readme.txt'] as never);
      vi.mocked(statSync).mockReturnValue({ isDirectory: () => false } as never);

      expect(resolvePluginDirs()).toEqual([]);
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

  describe('getBinaryStatus (packaged-mode path resolution)', () => {
    // Regression coverage for the "engines show Not Loaded in packaged build"
    // bug: the real defect was that binaries/ was never populated before
    // packaging (see scripts/download-binaries.ts), not this resolution logic
    // — but that logic had zero test coverage, so nothing would have caught
    // a real regression here either. These pin down both outcomes.
    it('reports available:true when the binary exists under process.resourcesPath (packaged mode)', async () => {
      const electron = await import('electron');
      // @ts-expect-error — mocked module, isPackaged is writable here
      electron.app.isPackaged = true;
      // Real Electron augments the global `process` object with resourcesPath at
      // runtime — binary-resolver.ts reads it as an ambient global, not an import
      // from 'electron', so it must be set here rather than in the electron mock.
      const originalResourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath;
      (process as unknown as { resourcesPath: string }).resourcesPath = '/tmp/resources';

      const { existsSync } = await import('fs');
      vi.mocked(existsSync).mockImplementation(
        (path: unknown) => typeof path === 'string' && path === '/tmp/resources/binaries/yt-dlp.exe',
      );
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

      const status = getBinaryStatus();
      const ytDlp = status.find((s) => s.name === 'yt-dlp');
      expect(ytDlp).toEqual({ name: 'yt-dlp', path: '/tmp/resources/binaries/yt-dlp.exe', available: true });

      // @ts-expect-error — reset for other tests
      electron.app.isPackaged = false;
      (process as unknown as { resourcesPath?: string }).resourcesPath = originalResourcesPath;
    });

    it('reports available:false when packaged resources have no binaries and PATH has none either', async () => {
      const electron = await import('electron');
      // @ts-expect-error — mocked module, isPackaged is writable here
      electron.app.isPackaged = true;

      const { existsSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(false);
      const originalPathEnv = process.env.PATH;
      process.env.PATH = '';

      const status = getBinaryStatus();
      expect(status).toEqual([
        { name: 'yt-dlp', path: null, available: false },
        { name: 'ffmpeg', path: null, available: false },
      ]);

      process.env.PATH = originalPathEnv;
      // @ts-expect-error — reset for other tests
      electron.app.isPackaged = false;
    });
  });
});