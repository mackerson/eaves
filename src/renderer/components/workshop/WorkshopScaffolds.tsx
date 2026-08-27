/**
 * The blank page, answered.
 *
 * "Describe what you want Eaves to do" in an empty composer is the worst
 * prompting surface in the app: the person does not yet know what a plugin
 * here can be, and the agent gets a one-line ask with no shape to it. These
 * are not templates in the code-generation sense — nothing is scaffolded on
 * disk — they are openings, phrased the way a request that goes well is
 * phrased, and they name the four things the plugin system can actually
 * extend so the answer is not a guess.
 */

export interface Scaffold {
  title: string;
  blurb: string;
  /** Seeded into the composer, editable before it is sent. */
  prompt: string;
}

export const SCAFFOLDS: Scaffold[] = [
  {
    title: 'A tool your agents can call',
    blurb: 'Something an agent can do mid-conversation — roll dice, convert units, look something up.',
    prompt:
      'Build a plugin that registers a tool my agents can call. It should ' +
      '[what it does]. Ask me anything you need about the behaviour before you write it, ' +
      'and check plugin_inspect for the API and permissions first.',
  },
  {
    title: 'A panel in the app',
    blurb: 'A view with its own UI — a dashboard, a reference card, a thing you keep open.',
    prompt:
      'Build a plugin with a UI panel that shows [what it shows]. Read plugin_inspect ' +
      'with what:"api" for the UI bundle shape first — React is externalised and there is ' +
      'no build step. When it is running, tell me to preview it so you can see whether it rendered.',
  },
  {
    title: 'Something that reacts to what happens',
    blurb: 'Listens for app events — a message arriving, a task changing — and does something.',
    prompt:
      'Build a plugin that listens for [which event] and then [what it does]. ' +
      'Check plugin_inspect for which events are available and what grant listening needs.',
  },
  {
    title: 'Something that stores its own data',
    blurb: 'Keeps notes, counters, or settings of its own between sessions.',
    prompt:
      'Build a plugin that keeps track of [what] using its own storage, and ' +
      '[how I get at it]. Use plugin_inspect to check the storage API before you write it.',
  },
];

export function WorkshopScaffolds({ onPick }: { onPick: (prompt: string) => void }) {
  return (
    <div className="w-full max-w-xl">
      <p className="text-lg font-medium text-center">What should Eaves be able to do?</p>
      <p className="text-sm text-muted-foreground mt-2 text-center">
        Describe it in your own words, or start from one of these. An agent writes it, you watch it
        happen, and nothing is installed until you say so.
      </p>
      <div className="grid sm:grid-cols-2 gap-2 mt-5">
        {SCAFFOLDS.map((scaffold) => (
          <button
            key={scaffold.title}
            onClick={() => onPick(scaffold.prompt)}
            className="text-left p-3 rounded-lg border border-border hover:bg-accent/50 transition-colors"
          >
            <p className="text-sm font-medium">{scaffold.title}</p>
            <p className="text-xs text-muted-foreground mt-1">{scaffold.blurb}</p>
          </button>
        ))}
      </div>
    </div>
  );
}
