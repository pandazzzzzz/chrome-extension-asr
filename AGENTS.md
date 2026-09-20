# Repository Guidelines

## Project Structure & Module Organization
This repository is a Manifest V3 Chrome extension template with no bundler step.

- `manifest.json`: extension metadata, permissions, and entry points.
- `background/background.js`: service worker logic and cross-context message handling.
- `content/content.js`, `content/content.css`: scripts and styles injected into matched pages.
- `popup/popup.html`, `popup/popup.js`, `popup/popup.css`: extension popup UI and behavior.
- `icons/`: extension icons (`16`, `48`, `128` sizes).
- Root docs: `README.md`, `CONTRIBUTING.md`.

Keep feature logic close to its runtime context (popup vs content vs background), and prefer small, focused files.

## Build, Test, and Development Commands
- `npm run build`: placeholder build command (currently no compile step).
- `npm run lint`: placeholder lint command; wire this to your linter before enforcing CI checks.
- `npm run pack`: creates `extension.zip` for distribution.

Local development:
1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click **Load unpacked** and select this repository.
4. Reload the extension after edits.

## Coding Style & Naming Conventions
- JavaScript/CSS/HTML use 2-space indentation and semicolons, matching current files.
- Use descriptive `camelCase` for variables/functions (`performPageAction`, `showStatus`).
- Keep message contract names explicit, e.g. `request.action === 'setData'`.
- Use clear folder-scoped names like `popup.js`, `content.css`, `background.js`.

If you add lint/format tooling, keep rules aligned with the existing style and update `npm run lint`.

## Testing Guidelines
There is currently no automated test suite in this repository.

Minimum validation before PR:
- Load unpacked extension and verify popup opens.
- Confirm content script behavior on a normal webpage.
- Verify background message flows and `chrome.storage.sync` reads/writes.
- Re-test install/update paths by reloading the extension.

When adding tests, prefer colocated tests with clear names such as `popup.test.js` or `content.integration.test.js`.

## Commit & Pull Request Guidelines
Follow the commit prefixes documented in `CONTRIBUTING.md`:
- `feat:`, `fix:`, `docs:`, `style:`, `refactor:`, `test:`, `chore:`.

PR checklist:
- Clear summary of behavior changes.
- Linked issue (for bugs/features).
- Reproduction and verification steps.
- Screenshots or short recordings for popup/UI changes.
