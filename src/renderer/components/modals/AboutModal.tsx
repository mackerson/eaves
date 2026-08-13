import { useEffect, useMemo, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { buildMenuModel, collectAccelerators } from '@shared/menuModel';
import { formatAccelerator, type MenuPlatform } from '@shared/accelerators';
import { VaporwaveShader } from '../effects/VaporwaveShader';
import './AboutModal.css';

interface AboutModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// Minecraft-style splash text — the yellow bit that dances under the logo. One
// is picked at random each time the dialog opens.
const SPLASHES = [
  'Subpoena-resistant!',
  'No clouds were harmed.',
  'Now with 100% less telemetry!',
  'We have AI at home!',
  'Internet optional!',
  'Airplane mode approved!',
  'Works in the bunker!',
  'One supervisor, infinite minions!',
  'The minions are unionized!',
  'Delegating downward since day one!',
  'Locally sourced intelligence!',
  'Free-range tokens!',
  'Reticulating splines!',
  'Compiles on the first try! (load-bearing lie)',
  'As seen on your own hardware!',
  "Probably won't catch fire!",
  'The factory must grow!',
  'Also try Factorio!',
];

/** `process.platform` is wider than the menu model's three cases. */
function resolvePlatform(): MenuPlatform {
  const platform = typeof window !== 'undefined' ? window.electron?.platform : undefined;
  if (platform === 'darwin') return 'darwin';
  if (platform === 'win32') return 'win32';
  return 'linux';
}

interface ShortcutGroup {
  id: string;
  label: string;
  rows: Array<{ key: string; chord: string; label: string }>;
}

/**
 * The shortcut list, read out of the menu model rather than typed out here.
 *
 * `collectAccelerators` flattens, so it is called once per top-level menu to
 * keep the grouping — it still recurses into nested submenus (Tools ▸
 * Developer), which a hand-rolled walk here would have to duplicate.
 */
function buildShortcutGroups(platform: MenuPlatform): ShortcutGroup[] {
  return buildMenuModel(platform)
    .map((menu) => ({
      id: menu.id,
      label: menu.label,
      rows: collectAccelerators([menu]).map((entry) => ({
        key: `${entry.id}:${entry.accelerator}`,
        chord: formatAccelerator(entry.accelerator, platform),
        label: entry.label,
      })),
    }))
    .filter((group) => group.rows.length > 0);
}

export function AboutModal({ open, onOpenChange }: AboutModalProps) {
  const handleClose = () => onOpenChange(false);

  // Platform is fixed for the life of the process, so this runs once.
  const shortcutGroups = useMemo(() => buildShortcutGroups(resolvePlatform()), []);

  // Pull the real app version from the main process so it never drifts from
  // package.json on a version bump.
  const [version, setVersion] = useState<string>('…');
  useEffect(() => {
    window.electron.getAppVersion()
      .then((r) => setVersion(r.version))
      .catch(() => setVersion('unknown'));
  }, []);

  // Re-roll the splash each time the dialog opens, Minecraft-style.
  const [splash, setSplash] = useState(SPLASHES[0]);
  useEffect(() => {
    if (open) setSplash(SPLASHES[Math.floor(Math.random() * SPLASHES.length)]);
  }, [open]);

  // Copyright: first-publication year, auto-extending to the current year as a
  // range (© 2025–2026) so the notice ages without manual edits.
  const currentYear = new Date().getFullYear();
  const copyrightYears = currentYear > 2025 ? `2025–${currentYear}` : '2025';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="winamp-modal sm:max-w-[480px] p-0">
        {/* Radix requires Title + Description on every DialogContent for screen
            readers. The visible title lives in .winamp-titlebar; these are
            sr-only mirrors so the accessibility tree stays correct without
            disturbing the Winamp aesthetic. */}
        <DialogTitle className="sr-only">About Enclave</DialogTitle>
        <DialogDescription className="sr-only">
          Version, credits, and links for the Enclave application.
        </DialogDescription>
        <div className="winamp-window">
          {/* Window title bar */}
          <div className="winamp-titlebar">
            <span className="winamp-title">About</span>
            <button
              type="button"
              className="winamp-titlebar-close"
              onClick={handleClose}
              aria-label="Close"
            >
              ×
            </button>
          </div>

          {/* Main content area */}
          <div className="winamp-content">
            <Tabs defaultValue="enclave" className="winamp-tabs">
              <TabsList className="winamp-tablist">
                <TabsTrigger value="enclave" className="winamp-tab">
                  Enclave
                </TabsTrigger>
                <TabsTrigger value="credits" className="winamp-tab">
                  Credits
                </TabsTrigger>
                <TabsTrigger value="opensource" className="winamp-tab">
                  Open Source
                </TabsTrigger>
                <TabsTrigger value="tips" className="winamp-tab">
                  Tips
                </TabsTrigger>
                <TabsTrigger value="links" className="winamp-tab">
                  Links
                </TabsTrigger>
              </TabsList>

              {/* Enclave Tab */}
              <TabsContent value="enclave" className="winamp-tabcontent">
                <div className="visualization-container">
                  <VaporwaveShader />
                  <div className="splash-text" key={splash}>{splash}</div>
                </div>
                <div className="about-text">
                  <p className="version-text">Version {version}</p>
                  <p className="tagline-text">
                    Local-first AI assistant with persistent memory
                  </p>
                  <p className="description-text">
                    AI chat that remembers your projects, works offline, and respects your
                    privacy.
                  </p>
                  <p className="copyright-text">Copyright © {copyrightYears} Ackerson Labs LLC</p>
                  <p className="visit-text">
                    Visit{' '}
                    <a
                      href="https://github.com/mackerson/enclave-ai"
                      className="winamp-link"
                      onClick={(e) => {
                        e.preventDefault();
                        window.electron.openExternal('https://github.com/mackerson/enclave-ai');
                      }}
                    >
                      github.com/mackerson/enclave-ai
                    </a>{' '}
                    for updates.
                  </p>
                </div>
              </TabsContent>

              {/* Credits Tab */}
              <TabsContent value="credits" className="winamp-tabcontent">
                <div className="credits-content">
                  <h3 className="winamp-subheading">Development</h3>
                  <p className="credit-line">Created by Michael &lsquo;Miz&rsquo; Ackerson</p>

                  <h3 className="winamp-subheading">Powered By</h3>
                  <p className="credit-line">Electron Framework</p>
                  <p className="credit-line">React & TypeScript</p>

                  <h3 className="winamp-subheading">Special Thanks</h3>
                  <p className="credit-line">Claude — for being my hands, and a bud</p>
                  <p className="credit-line">Nullsoft Winamp — for the vibes</p>
                  <p className="credit-line">shadcn/ui for component library</p>
                  <p className="credit-line">Radix UI for primitives</p>
                  <p className="credit-line">The open source community</p>
                </div>
              </TabsContent>

              {/* Open Source Tab */}
              <TabsContent value="opensource" className="winamp-tabcontent">
                <div className="opensource-content">
                  <h3 className="winamp-subheading">Free & Open Source Software</h3>
                  <p className="opensource-text">
                    Enclave is free and open source software, released under the MIT License.
                    You are free to use, modify, and distribute it under those terms.
                  </p>

                  <h3 className="winamp-subheading">Contributing</h3>
                  <p className="opensource-text">
                    Contributions are welcome! Visit the GitHub repository to submit issues,
                    feature requests, or pull requests.
                  </p>

                  <h3 className="winamp-subheading">License</h3>
                  <p className="opensource-text">
                    Distributed under the MIT License. See the LICENSE file in the
                    repository for the full text.
                  </p>

                  <h3 className="winamp-subheading">Bundled Fonts</h3>
                  <p className="opensource-text">
                    OpenDyslexic © Abbie Gonzalez, licensed under the{' '}
                    <a
                      href="https://openfontlicense.org/"
                      className="winamp-link"
                      onClick={(e) => {
                        e.preventDefault();
                        window.electron.openExternal('https://openfontlicense.org/');
                      }}
                    >
                      SIL Open Font License 1.1
                    </a>
                    . Source:{' '}
                    <a
                      href="https://github.com/antijingoist/opendyslexic"
                      className="winamp-link"
                      onClick={(e) => {
                        e.preventDefault();
                        window.electron.openExternal(
                          'https://github.com/antijingoist/opendyslexic'
                        );
                      }}
                    >
                      github.com/antijingoist/opendyslexic
                    </a>
                    .
                  </p>

                  <div className="opensource-cta">
                    <p className="cta-text">Help make Enclave better!</p>
                    <p className="cta-subtext">
                      Star the project, report bugs, or contribute code.
                    </p>
                  </div>
                </div>
              </TabsContent>

              {/* Tips Tab */}
              <TabsContent value="tips" className="winamp-tabcontent">
                <div className="tips-content">
                  <h3 className="winamp-subheading">Getting Started</h3>
                  <ul className="tips-list">
                    <li>Create an agent, then @mention it in a channel to start talking</li>
                    <li>Bring your own models — cloud API keys or local via Ollama / LM Studio</li>
                    <li>Group work into projects; agents keep their memory across sessions</li>
                  </ul>

                  <h3 className="winamp-subheading">Pro Tips</h3>
                  <ul className="tips-list">
                    <li>Multiple agents can share a channel and respond to each other</li>
                    <li>Memory is persistent and local — agents recall past conversations</li>
                    <li>Runs fully offline with a local model — no cloud required</li>
                    <li>Your data stays on your machine — privacy first</li>
                  </ul>

                  <h3 className="winamp-subheading">Keyboard Shortcuts</h3>
                  {shortcutGroups.map((group) => (
                    <div key={group.id}>
                      <h4 className="tips-group-heading">{group.label}</h4>
                      <ul className="tips-list">
                        {group.rows.map((row) => (
                          <li key={row.key}>
                            <code>{row.chord}</code> - {row.label}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                  {/* Esc is handled by the dialogs themselves, not the menu, so
                      it has no entry in the model to derive from. */}
                  <h4 className="tips-group-heading">Elsewhere</h4>
                  <ul className="tips-list">
                    <li>
                      <code>Esc</code> - Close dialogs
                    </li>
                  </ul>
                </div>
              </TabsContent>

              {/* Links Tab */}
              <TabsContent value="links" className="winamp-tabcontent">
                <div className="links-content">
                  <h3 className="winamp-subheading">Project Links</h3>
                  <ul className="links-list">
                    <li>
                      <a
                        href="https://github.com/mackerson/enclave-ai"
                        className="winamp-link"
                        onClick={(e) => {
                          e.preventDefault();
                          window.electron.openExternal(
                            'https://github.com/mackerson/enclave-ai'
                          );
                        }}
                      >
                        GitHub Repository
                      </a>
                    </li>
                    <li>
                      <a
                        href="https://github.com/mackerson/enclave-ai/issues"
                        className="winamp-link"
                        onClick={(e) => {
                          e.preventDefault();
                          window.electron.openExternal(
                            'https://github.com/mackerson/enclave-ai/issues'
                          );
                        }}
                      >
                        Report an Issue
                      </a>
                    </li>
                  </ul>

                  <h3 className="winamp-subheading">Related Projects</h3>
                  <ul className="links-list">
                    <li>
                      <a
                        href="https://www.electronjs.org/"
                        className="winamp-link"
                        onClick={(e) => {
                          e.preventDefault();
                          window.electron.openExternal('https://www.electronjs.org/');
                        }}
                      >
                        Electron Framework
                      </a>
                    </li>
                    <li>
                      <a
                        href="https://ollama.com/"
                        className="winamp-link"
                        onClick={(e) => {
                          e.preventDefault();
                          window.electron.openExternal('https://ollama.com/');
                        }}
                      >
                        Ollama
                      </a>
                    </li>
                    <li>
                      <a
                        href="https://lmstudio.ai/"
                        className="winamp-link"
                        onClick={(e) => {
                          e.preventDefault();
                          window.electron.openExternal('https://lmstudio.ai/');
                        }}
                      >
                        LM Studio
                      </a>
                    </li>
                  </ul>
                </div>
              </TabsContent>
            </Tabs>
          </div>

          {/* Footer with buttons */}
          <DialogFooter className="winamp-footer">
            <Button onClick={handleClose} className="winamp-button" variant="outline">
              OK
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
