# Third-party notices

Pixel Sessions combines upstream components with local integration changes. Keep this file and the supplied license files with redistributed copies.

| Source | Pinned revision | Components and scope | Declared license |
| --- | --- | --- | --- |
| [Herdr app](https://github.com/herdrdev/herdr-app/tree/v0.1.16) | `v0.1.16` | Base layout, sidebar/picker/chrome, agents, pane headers, tabs, file browsing and accompanying assets | [Apache-2.0](https://github.com/herdrdev/herdr-app/blob/v0.1.16/LICENSE) |
| [Pixel Spaces](https://github.com/pilmokim/herdr-pixel-spaces/tree/72ae9e425586b75a36daab55e9e4752ae8590f94) | `72ae9e425586b75a36daab55e9e4752ae8590f94` | Pixel sprite drawings and assignment/cycling design, waiting bell, picker/chrome changes, `pixel-icons/` | [Apache-2.0](https://github.com/pilmokim/herdr-pixel-spaces/blob/72ae9e425586b75a36daab55e9e4752ae8590f94/LICENSE) |
| [Clawd Icons](https://github.com/Agmat/herdr-clawd-icons/tree/593216d2f1a27566fe51e2dd719dc63af7483e20) | `593216d2f1a27566fe51e2dd719dc63af7483e20` | The 39 adapted mascot SVGs and terminal-address mapping idea | Supplied artwork notice is MIT; the repository has no blanket license declaration |
| [clawd-pet](https://github.com/abderrahimghazali/clawd-pet) | As credited by Clawd Icons | Original artwork adapted by Clawd Icons | MIT, copyright 2026 Abderrahim GHAZALI; supplied notice retained |
| [Herdr Main + Usage](https://github.com/plutotw/herdr-main-usage/tree/ee244edf49da251c276d615abb614d29ffbb5ef0) | `ee244edf49da251c276d615abb614d29ffbb5ef0` | Markdown rendering/preview additions in `files-md-tools` and `md-preview-tools`; history UI/parser in `history-tools`; History tab integration design | No license file or upstream license declaration at this revision |
| [Lucide](https://lucide.dev/) | Notices supplied by Pixel Spaces | Search, sidebar, settings and plus glyphs under `mods/pixel-chrome/` | ISC, with MIT notices for Feather-derived glyphs |

The Herdr source portions remain Apache-2.0. An unspecified license on an upstream addition is not represented as Apache-2.0 merely because the addition was made to an Apache-licensed base. This package does not claim additional rights over those original additions.

Integration changes include rebasing the pixel mods on Herdr 0.1.16, preserving per-terminal mascot identity across views, combining the three right-panel tabs, reusable file preview panes, file-list keyboard navigation, watch/lifecycle fixes, bounded image preparation and caches, local resume routing, and transcript-format/turn parsing fixes.

Claude Code and Clawd are Anthropic's names/character. Codex is OpenAI's name. The supplied pixel program glyphs are unofficial original glyphs, not official logos. Pixel Sessions is an unofficial community project.
