// Role: turn detected audio into the preferences the picker offers.
//
// The Audio control used to be a hardcoded Auto / English dub / Original list,
// rendered before anything had been analysed and shown for every source. It is
// implemented with yt-dlp's `--format-sort lang:…`, which reorders the audio
// renditions *inside one manifest* — so it can only do anything when the source
// actually carries more than one audio language.
//
// On the anime hosts this app targets, it never can: anikoto serves sub and dub
// as two completely different manifest URLs, chosen by clicking a server in the
// page. So the always-visible control was structurally incapable of working
// there, while the control that does work — the detected stream options — was
// hidden behind a button. The prominent choice was the fake one.
//
// The rule here is the same one `quality.ts` already applies: an option is
// offered only when the source reported something that makes it meaningful.
import type { AudioTrack } from './types';

export type AudioPreference = 'auto' | 'dub' | 'sub';

export interface AudioChoice {
  label: string;
  value: AudioPreference;
}

const AUTO: AudioChoice = { label: 'Auto', value: 'auto' };

/**
 * Preferences worth offering for the audio tracks actually detected.
 *
 * `--format-sort lang:` needs at least two audio languages to choose between;
 * with one (or none) detected there is nothing to sort, so only Auto is
 * offered rather than presenting a choice that cannot take effect.
 */
export function buildAudioChoices(tracks: AudioTrack[] | undefined): AudioChoice[] {
  const languages = new Set(
    (tracks || [])
      .map((track) => (track.language || '').trim().toLowerCase())
      .filter((language) => language && language !== 'und'),
  );

  if (languages.size < 2) return [AUTO];

  return [
    AUTO,
    { label: 'Prefer English dub', value: 'dub' },
    { label: 'Prefer original', value: 'sub' },
  ];
}

/**
 * Whether the source exposes separate language streams — the mechanism that
 * actually carries dub/sub on the anime hosts, as distinct from audio tracks
 * within one manifest.
 */
export function hasLanguageStreams(optionCount: number | undefined): boolean {
  return (optionCount ?? 0) > 1;
}
