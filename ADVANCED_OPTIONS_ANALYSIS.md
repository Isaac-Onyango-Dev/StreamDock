# StreamDock Advanced Options Analysis

## Current Implementation

### 1. Audio Preference Dropdown (`Audio`)
**Current behavior:**
- Options: `Auto`, `English dub`, `Original`
- Code location: [client/src/views/CaptureView/index.tsx](client/src/views/CaptureView/index.tsx#L756)
- Download logic: [electron/download-engine.ts](electron/download-engine.ts#L1171)

**BUG IDENTIFIED:** Line 423 in CaptureView forces `audioPreference` to `'auto'` when a track probe is detected:
```typescript
audioPreference: trackProbe ? 'auto' : audioPreference,
```
This means **the dropdown is non-functional when dubs/subs are detected** (which is the common case).

**Impact:** Users cannot select "English dub" or "Original" if the track probe finds alternates.

---

### 2. Subtitle Delivery Mode (`Subtitles`)
**Current behavior:**
- Options: `Embed`, `Sidecar .srt`, `None`
- Code location: [client/src/views/CaptureView/index.tsx](client/src/views/CaptureView/index.tsx#L762)
- Download logic: [electron/download-engine.ts](electron/download-engine.ts#L1186)

**Status:** ✅ Working correctly. Properly passed to yt-dlp as `--embed-subs`, `--convert-subs srt`, or omitted.

---

### 3. Browser Impersonation (`Browser impersonation`)
**Current behavior:**
- Options: `Default`, `Chrome`, `Firefox`, `Safari`
- Code location: [client/src/views/CaptureView/index.tsx](client/src/views/CaptureView/index.tsx#L768)
- Implementation: [electron/download-engine.ts](electron/download-engine.ts#L1200+) `buildImpersonationArgs()`

**Status:** ⚠️ Partially working. User-Agent is set, but:
- yt-dlp doesn't use the `impersonate` field directly in modern versions
- Modern yt-dlp uses `--http-client requests` or browser-specific headers
- The setting may be ignored silently

---

## Issue: Multiple Video Provider Options (CDN Selection)

**Observation:** Some anime on Anikoto have multiple CDN providers:
- Provider 1: Current episodes (what user wants)
- Provider 2: Old/outdated episodes
- Provider 3: Alternative (may also work)

**Current behavior:** StreamDock probes the first available manifest and uses it, with no UI picker for alternate providers.

**Root cause:** The manifest extractor finds the first `.m3u8` or API response and stops. Multiple providers are not exposed to the user for selection.

---

## Recommendations

### FIX #1: Respect `audioPreference` when Track Probe is detected

**File:** `client/src/views/CaptureView/index.tsx` line 423

Change:
```typescript
audioPreference: trackProbe ? 'auto' : audioPreference,
```

To:
```typescript
audioPreference: audioPreference,  // Always respect user selection
```

**Rationale:** The `selectedAudioLanguage` field (from the modal) already handles explicit user selection. The `audioPreference` field should act as a fallback/hint when no explicit language is chosen.

---

### FIX #2: Improve Browser Impersonation Support

**File:** `electron/download-engine.ts` (line ~1200+)

Update `buildImpersonationArgs()` to use modern yt-dlp flags:
```typescript
if (request.impersonate === 'firefox') {
  args.push('--http-client', 'requests');  // or 'httpx'
  args.push('-H', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0');
} else if (request.impersonate === 'chrome') {
  args.push('-H', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36');
} else if (request.impersonate === 'safari') {
  args.push('-H', 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3.1 Safari/605.1.15');
}
```

---

### ENHANCEMENT: Multi-Provider CDN Selection

**Goal:** Allow users to see and pick between alternate CDN providers before download.

**Implementation approach:**

1. **Enhance `manifest-extractor.ts`** to capture alternate manifest URLs from the same page (not just the first one).

2. **Add new field to probe result:**
   ```typescript
   export interface ManifestResult {
     originalUrl: string;
     manifestUrl: string;
     alternateManifests?: {
       provider: string;      // e.g., "cdn.mewstream.buzz", "megaplay.buzz"
       url: string;
       timestamp?: number;    // when it was discovered
     }[];
     // ... existing fields
   }
   ```

3. **Update UI** in `MediaLanguageSelectionModal.tsx` or new modal to show provider picker:
   ```
   ┌─────────────────────────────────────────────────┐
   │  Select Video Provider:                         │
   │                                                 │
   │  ○ cdn.mewstream.buzz (current, found first)   │
   │  ○ megaplay.buzz (alternative)                  │
   │  ○ vizcloud.online (alternative)                │
   │                                                 │
   │  [Continue]                                     │
   └─────────────────────────────────────────────────┘
   ```

4. **Pass selected provider manifest** to download engine via new field:
   ```typescript
   interface StartRequest {
     // ...
     selectedManifestUrl?: string;  // override default with user's choice
   }
   ```

---

## Summary Table

| Feature | Status | Notes |
|---------|--------|-------|
| Audio preference | ❌ Broken | Forced to 'auto' when track probe active |
| Subtitle mode | ✅ Working | Embed/sidecar/none all functional |
| Browser impersonate | ⚠️ Partial | Flags may not match modern yt-dlp |
| Multi-provider CDN | ❌ Missing | No UI picker, always uses first manifest |
| Multi-dub selection | ✅ Partial | Works if user manually selects from modal |

---

## Quick Fixes Priority

**High (1 line each):**
1. Remove audioPreference override (FIX #1)
2. Respect `selectedAudioLanguage` (already working)

**Medium:**
1. Update impersonation flag logic (FIX #2)

**Nice-to-have:**
1. Implement multi-provider CDN picker

