# `@agentgrade/react`

Drop-in WebMCP for React. Register agent-callable tools with `useWebMCP`, or
make an existing form agent-callable with `<AgentForm />`.

```bash
npm install @agentgrade/react
```

Zero dependencies. `react >= 18` is the only peer.

## `useWebMCP`

```tsx
import { useWebMCP } from '@agentgrade/react';

function ProductSearch() {
  useWebMCP({
    name: 'search_products',
    description: 'Search the catalog and return matching items.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-text search terms.' },
        limit: { type: 'integer', description: 'Maximum results.', minimum: 1, maximum: 50 },
      },
      required: ['query'],
      additionalProperties: false,
    },
    execute: ({ query, limit }) => searchProducts(query, limit),
  });

  return <SearchUI />;
}
```

What it handles for you:

- **Registration on both hosts.** `navigator.modelContext` and
  `document.modelContext` — implementations disagree about which.
- **Cleanup on unmount.** A tool that outlives its component hands the agent a
  dead closure.
- **Runtime validation.** Arguments are checked against `inputSchema` before
  `execute` sees them, and a rejection tells the model *what* was wrong.
- **`readOnlyHint` inference.** Derived from the tool's leading verb —
  `search_*` is read-only, `place_*` is not. An unclassifiable name is treated
  as a mutation, because claiming read-only when unsure is the error that costs
  money.
- **Result normalisation.** Return a string, an object, or a full envelope.

### Validation with Zod (or anything else)

`validator` accepts a Zod schema, any [Standard Schema](https://standardschema.dev)
implementation, or a plain predicate — none of them a dependency of this package:

```tsx
useWebMCP({
  name: 'create_account',
  description: 'Create a customer account.',
  inputSchema: accountJsonSchema,   // what the agent sees
  validator: accountZodSchema,      // what actually runs
  execute: (args) => createAccount(args),
});
```

The validator's parsed output is what reaches `execute`, so a transforming
schema transforms.

## `<AgentForm />`

An agent facing an ordinary form has to find it, work out what each input wants,
fill them one at a time, and find the submit control. `AgentForm` inspects its
own rendered fields, derives a JSON Schema from their types and labels, and
registers a tool that takes all the values at once:

```tsx
import { AgentForm } from '@agentgrade/react';

<AgentForm
  toolName="place_order"
  description="Place the order for the items in the cart."
  onSubmit={handleSubmit}
>
  <label htmlFor="email">Email address</label>
  <input id="email" name="email" type="email" required />

  <label htmlFor="ship">Shipping</label>
  <select id="ship" name="ship">
    <option value="standard">Standard</option>
    <option value="express">Express</option>
  </select>

  <button type="submit">Buy</button>
</AgentForm>
```

That registers `place_order` with `email` (string, format `email`, required) and
`ship` (string, enum `["standard","express"]`). When an agent calls it, the
values are written into the real inputs and the form submits through
`requestSubmit()` — so your own `onSubmit`, validation, and analytics all run.
One code path for humans and agents.

| Prop | Description |
| --- | --- |
| `toolName`, `description` | The registered tool. |
| `onAgentSubmit` | Handle the agent's values yourself instead of submitting. |
| `fieldOverrides` | Per-field schema overrides, keyed by property name. |
| `exclude` | Field names to keep out of the schema (CSRF tokens, honeypots). |
| `readOnly`, `destructive` | Override the inferred annotations. |
| `registerTool` | Set `false` to render without registering. |
| `onSchemaChange` | Notified whenever the derived schema changes. |

Hidden, submit, and file inputs are excluded automatically. A `MutationObserver`
keeps the schema in step with fields that appear later — a schema that stops
tracking its form starts lying to the agent.

Labels become parameter descriptions, because someone already wrote that text
for a person. A field with no label gets a description saying so, rather than an
invented one.

## Browsers without WebMCP

`ensureModelContext()` installs a marked polyfill (`__agentgradePolyfill`) so the
declarations stay present and inspectable — by an extension, a test, or an
auditor — even where nothing can call them. Pass `polyfill: false` to register
only where the platform is real.
