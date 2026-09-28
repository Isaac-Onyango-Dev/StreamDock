; Role: make the Windows installer and uninstaller look like StreamDock.
;
; electron-builder includes this file (build/installer.nsh) before Modern UI
; builds its pages, so these defines decide how every page is drawn. Without
; them the Welcome and Finish pages showed NSIS's stock blue nsis3-metro.bmp
; beside a white page, and the whole window was bitmap-stretched by Windows,
; so its text was blurry at 125% scaling.
;
; The artwork is rendered from the brand by scripts/generate-installer-art.ts
; (npm run installer:art); electron-builder finds build/installerSidebar.bmp and
; build/installerHeader.bmp by name.

; The page colour behind the Welcome/Finish text and the header band: the
; brand's ink (design/tokens.json), with near-white text.
!define MUI_BGCOLOR "0A0716"
!define MUI_TEXTCOLOR "F3F0FF"

; Draw the art at its real size. NSIS stretches with nearest-neighbour, which
; makes the mark jagged; the art's edges fade into MUI_BGCOLOR instead, so a
; larger control at 125%+ scaling just shows more of the same colour.
!define MUI_WELCOMEFINISHPAGE_BITMAP_STRETCH "NoStretchNoCrop"
!define MUI_UNWELCOMEFINISHPAGE_BITMAP_STRETCH "NoStretchNoCrop"
!define MUI_HEADERIMAGE_BITMAP_STRETCH "NoStretchNoCrop"

; A themed checkbox ignores the text colour Modern UI sets (its bug #443), so
; "Run StreamDock" on the Finish page would be black on a dark page. Classic
; controls honour it.
!define MUI_FORCECLASSICCONTROLS

; Crisp text at any display scaling, instead of Windows stretching a 96-DPI
; window as a bitmap.
ManifestDPIAware true

; "Run StreamDock" on the Finish page opened the Start Menu shortcut through
; Explorer (StdUtils ExecShellAsUser). On Windows 11 build 26200 Explorer
; answered "Windows cannot find '...\StreamDock.lnk'. Make sure you typed the
; name correctly" for a shortcut that exists, and the app never started;
; reproduced outside the installer, the call returns "timeout" for the
; shortcut and "ok" for StreamDock.exe. Launching the exe keeps what
; ExecShellAsUser is for: an all-users install runs elevated, and the app must
; still start as the user. The app sets its own AppUserModelID (main.ts), so
; it groups and notifies the same however it was started.
!macro customInstall
  StrCpy $launchLink "$appExe"
!macroend
