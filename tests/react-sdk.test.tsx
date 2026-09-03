/**
 * @vitest-environment jsdom
 *
 * Tests for `@agentgrade/react`.
 *
 * Two properties carry the package: a tool registered by a component must go
 * away when that component does — a tool that outlives its owner hands the
 * agent a dead closure — and arguments must be validated before they reach
 * application code.
 */

import { useState } from 'react';

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AgentForm,
  buildSchema,
  classifyTool,
  ensureModelContext,
  getModelContext,
  getModelContextHost,
  inferDestructive,
  inferReadOnly,
  inspectForm,
  toWebMcpResult,
  useWebMCP,
  useWebMCPTools,
  validateAgainstJsonSchema,
  validateArguments,
  type JsonSchema,
  type RegisteredWebMcpTool,
  type WebMcpResult,
} from '../packages/react/src/index.js';
import { classifyToolByLanguage } from '../src/evals/analysis.js';
import type { RegisteredTool } from '../src/scanner/types.js';

afterEach(() => {
  cleanup();
  delete (navigator as { modelContext?: unknown }).modelContext;
  delete (document as { modelContext?: unknown }).modelContext;
});

/** Reads the registry the way an agent would. */
function registeredTools(): RegisteredWebMcpTool[] {
  return (getModelContext()?.getTools?.() ?? []) as RegisteredWebMcpTool[];
}

function findTool(name: string): RegisteredWebMcpTool {
  const tool = registeredTools().find((entry) => entry.name === name);
  if (!tool) throw new Error(`Tool "${name}" is not registered.`);
  return tool;
}

/** Invokes a registered tool inside `act`, since handlers set React state. */
async function callTool(name: string, args: unknown): Promise<WebMcpResult> {
  const tool = findTool(name);
  let result!: WebMcpResult;
  await act(async () => {
    result = (await tool.execute(args as never)) as WebMcpResult;
  });
  return result;
}

const SEARCH_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'Free-text search.' },
    limit: { type: 'integer', description: 'Maximum results.', minimum: 1, maximum: 50 },
  },
  required: ['query'],
  additionalProperties: false,
};

/* -------------------------------------------------------------------------- */

describe('runtime', () => {
  it('installs a marked polyfill only when the browser has none', () => {
    expect(getModelContext()).toBeNull();
    expect(getModelContextHost()).toBeNull();

    const context = ensureModelContext();
    expect(context).not.toBeNull();
    expect(context!.__agentgradePolyfill).toBe(true);
    expect(getModelContextHost()).toBe('polyfill');
  });

  it('prefers a native runtime over the polyfill, on either host', () => {
    const native = { registerTool: () => undefined, getTools: () => [] };
    (navigator as { modelContext?: unknown }).modelContext = native;
    expect(ensureModelContext()).toBe(native);
    expect(getModelContextHost()).toBe('navigator');

    delete (navigator as { modelContext?: unknown }).modelContext;
    (document as { modelContext?: unknown }).modelContext = native;
    expect(getModelContext()).toBe(native);
    expect(getModelContextHost()).toBe('document');
  });

  it('can be told not to polyfill', () => {
    expect(ensureModelContext({ polyfill: false })).toBeNull();
    expect(getModelContext()).toBeNull();
  });

  it('normalises whatever a handler returned into an envelope', () => {
    expect(toWebMcpResult('hello')).toEqual({ content: [{ type: 'text', text: 'hello' }] });
    expect(toWebMcpResult({ items: [1] })).toEqual({
      content: [{ type: 'text', text: '{"items":[1]}' }],
    });
    expect(toWebMcpResult(undefined)).toEqual({ content: [{ type: 'text', text: 'OK' }] });
    const envelope: WebMcpResult = { content: [{ type: 'text', text: 'already' }], isError: true };
    expect(toWebMcpResult(envelope)).toBe(envelope);
  });
});

/* -------------------------------------------------------------------------- */

describe('useWebMCP', () => {
  function SearchTool({ onCall }: { onCall?: (args: unknown) => void }) {
    useWebMCP({
      name: 'search_products',
      description: 'Search the catalog and return matching items.',
      inputSchema: SEARCH_SCHEMA,
      execute(args) {
        onCall?.(args);
        return { results: 3 };
      },
    });
    return <div>search</div>;
  }

  it('registers a tool with its schema and inferred annotations', () => {
    render(<SearchTool />);
    const tool = findTool('search_products');

    expect(tool.description).toBe('Search the catalog and return matching items.');
    expect(tool.inputSchema).toEqual(SEARCH_SCHEMA);
    // `search_*` is a query, so calling it speculatively is safe.
    expect(tool.annotations.readOnlyHint).toBe(true);
    expect(tool.annotations.destructiveHint).toBe(false);
  });

  it('unregisters the tool when the component unmounts', () => {
    const view = render(<SearchTool />);
    expect(registeredTools()).toHaveLength(1);

    view.unmount();
    expect(registeredTools()).toHaveLength(0);
  });

  it('unregisters when a conditionally rendered owner disappears', () => {
    function Page({ show }: { show: boolean }) {
      return <div>{show ? <SearchTool /> : null}</div>;
    }
    const view = render(<Page show />);
    expect(registeredTools().map((tool) => tool.name)).toEqual(['search_products']);

    view.rerender(<Page show={false} />);
    expect(registeredTools()).toHaveLength(0);

    view.rerender(<Page show />);
    expect(registeredTools()).toHaveLength(1);
  });

  it('passes validated arguments to the handler and normalises the result', async () => {
    const onCall = vi.fn();
    render(<SearchTool onCall={onCall} />);

    const result = await callTool('search_products', { query: 'boots', limit: 5 });
    expect(onCall).toHaveBeenCalledWith({ query: 'boots', limit: 5 });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe('{"results":3}');
  });

  it('rejects arguments that violate the declared schema, and says why', async () => {
    const onCall = vi.fn();
    render(<SearchTool onCall={onCall} />);

    const missing = await callTool('search_products', {});
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toContain('Missing required parameter "query"');

    const wrongType = await callTool('search_products', { query: 'boots', limit: 'five' });
    expect(wrongType.isError).toBe(true);
    expect(wrongType.content[0].text).toContain('"limit" must be an integer');

    const outOfRange = await callTool('search_products', { query: 'boots', limit: 500 });
    expect(outOfRange.isError).toBe(true);
    expect(outOfRange.content[0].text).toContain('at most 50');

    const unknown = await callTool('search_products', { query: 'boots', nope: 1 });
    expect(unknown.isError).toBe(true);
    expect(unknown.content[0].text).toContain('Unknown parameter "nope"');

    // Nothing invalid ever reached the handler.
    expect(onCall).not.toHaveBeenCalled();
  });

  it('accepts a Zod-style validator without depending on Zod', async () => {
    const zodLike = {
      safeParse(value: unknown) {
        const record = value as { query?: unknown };
        return typeof record?.query === 'string' && record.query.length >= 3
          ? { success: true as const, data: { query: record.query.toUpperCase() } }
          : { success: false as const, error: { issues: [{ path: ['query'], message: 'too short' }] } };
      },
    };

    function ZodTool({ onCall }: { onCall: (args: unknown) => void }) {
      useWebMCP({
        name: 'search_products',
        description: 'Search with a Zod schema.',
        validator: zodLike,
        execute: onCall,
      });
      return null;
    }

    const onCall = vi.fn();
    render(<ZodTool onCall={onCall} />);

    const bad = await callTool('search_products', { query: 'ab' });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toContain('query: too short');

    await callTool('search_products', { query: 'boots' });
    // The validator's parsed output is what the handler receives, so a
    // transforming schema actually transforms.
    expect(onCall).toHaveBeenCalledWith({ query: 'BOOTS' });
  });

  it('accepts a Standard Schema validator', async () => {
    const standard = {
      '~standard': {
        validate(value: unknown) {
          const record = value as { id?: unknown };
          return typeof record?.id === 'string'
            ? { value: record }
            : { issues: [{ message: 'id must be a string' }] };
        },
      },
    };

    function StandardTool() {
      useWebMCP({ name: 'get_item', description: 'Fetch an item.', validator: standard, execute: () => 'ok' });
      return null;
    }

    render(<StandardTool />);
    expect((await callTool('get_item', { id: 7 })).content[0].text).toContain('id must be a string');
    expect((await callTool('get_item', { id: 'a' })).content[0].text).toBe('ok');
  });

  it('turns a thrown handler into an error result and notifies onError', async () => {
    const onError = vi.fn();
    function ExplodingTool() {
      useWebMCP({
        name: 'get_thing',
        description: 'Fetch a thing.',
        execute() {
          throw new Error('backend down');
        },
        onError,
      });
      return null;
    }

    render(<ExplodingTool />);
    const result = await callTool('get_thing', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('backend down');
    expect(onError).toHaveBeenCalled();
  });

  it('calls the latest handler without re-registering on every render', async () => {
    const registerSpy = vi.fn();
    const context = ensureModelContext()!;
    const original = context.registerTool.bind(context);
    context.registerTool = (tool) => {
      registerSpy(tool.name);
      return original(tool);
    };

    function Counter() {
      const [count, setCount] = useState(0);
      useWebMCP({ name: 'get_count', description: 'Read the counter.', execute: () => String(count) });
      return <button onClick={() => setCount(count + 1)}>bump</button>;
    }

    render(<Counter />);
    expect(registerSpy).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText('bump'));
    fireEvent.click(screen.getByText('bump'));

    // Still one registration, but the tool sees the current value.
    expect(registerSpy).toHaveBeenCalledTimes(1);
    expect((await callTool('get_count', {})).content[0].text).toBe('2');
  });

  it('skips registration when disabled', () => {
    function OptionalTool({ enabled }: { enabled: boolean }) {
      useWebMCP({ name: 'get_thing', description: 'Fetch a thing.', enabled, execute: () => 'ok' });
      return null;
    }
    const view = render(<OptionalTool enabled={false} />);
    expect(getModelContext()).toBeNull();

    view.rerender(<OptionalTool enabled />);
    expect(registeredTools()).toHaveLength(1);
  });

  it('unregisters the tools it actually registered when the set shrinks', () => {
    function Surface({ names }: { names: string[] }) {
      useWebMCPTools(
        names.map((name) => ({ name, description: `Do ${name}.`, execute: () => 'ok' })) as never,
      );
      return null;
    }

    const view = render(<Surface names={['list_orders', 'list_items', 'list_users']} />);
    expect(registeredTools()).toHaveLength(3);

    // Cleanup has to undo *this* effect's registrations. Iterating the newest
    // array instead would leave the dropped tools stranded in the registry,
    // where an agent would find them and call a dead closure.
    view.rerender(<Surface names={['list_orders']} />);
    expect(registeredTools().map((tool) => tool.name)).toEqual(['list_orders']);

    view.rerender(<Surface names={['get_profile']} />);
    expect(registeredTools().map((tool) => tool.name)).toEqual(['get_profile']);

    view.unmount();
    expect(registeredTools()).toHaveLength(0);
  });

  it('re-registers when only a description or annotation changes', () => {
    function Surface({ description, readOnly }: { description: string; readOnly: boolean }) {
      useWebMCPTools([
        { name: 'do_thing', description, readOnly, execute: () => 'ok' },
      ] as never);
      return null;
    }

    const view = render(<Surface description="First wording." readOnly />);
    expect(findTool('do_thing').description).toBe('First wording.');
    expect(findTool('do_thing').annotations.readOnlyHint).toBe(true);

    view.rerender(<Surface description="Second wording." readOnly={false} />);
    // A key that only covered name and schema would leave both of these stale.
    expect(findTool('do_thing').description).toBe('Second wording.');
    expect(findTool('do_thing').annotations.readOnlyHint).toBe(false);
  });

  it('accepts a call with no arguments when the schema requires nothing', async () => {
    function Optional() {
      useWebMCP({
        name: 'list_issues',
        description: 'List the issues.',
        inputSchema: {
          type: 'object',
          properties: { severity: { type: 'string' } },
          required: [],
          additionalProperties: false,
        },
        execute: (args) => JSON.stringify(args ?? {}),
      });
      return null;
    }

    render(<Optional />);

    // An agent legitimately omits the payload when nothing is required.
    for (const args of [undefined, null, {}]) {
      const result = await callTool('list_issues', args);
      expect(result.isError, String(args)).toBeUndefined();
    }
  });

  it('registers several tools at once and tears them all down', () => {
    function Surface() {
      useWebMCPTools([
        { name: 'list_orders', description: 'List orders.', execute: () => [] },
        { name: 'cancel_order', description: 'Cancel an order.', execute: () => 'done' },
      ] as never);
      return null;
    }

    const view = render(<Surface />);
    expect(registeredTools().map((tool) => tool.name).sort()).toEqual(['cancel_order', 'list_orders']);
    expect(findTool('list_orders').annotations.readOnlyHint).toBe(true);
    expect(findTool('cancel_order').annotations.readOnlyHint).toBe(false);
    expect(findTool('cancel_order').annotations.destructiveHint).toBe(true);

    view.unmount();
    expect(registeredTools()).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */

describe('semantics', () => {
  it('infers read/write intent from the leading verb', () => {
    expect(inferReadOnly('search_products')).toBe(true);
    expect(inferReadOnly('get_order_status', 'Return the status of an order.')).toBe(true);
    expect(inferReadOnly('place_order')).toBe(false);
    expect(inferReadOnly('add_to_cart')).toBe(false);
    expect(inferDestructive('delete_account')).toBe(true);
    expect(inferDestructive('list_orders')).toBe(false);
  });

  it('treats an unclassifiable tool as a mutation, the safe direction', () => {
    expect(classifyTool('frobnicate_widget')).toBe('unknown');
    // Claiming read-only when unsure is the dangerous error: an agent may call
    // a read-only tool speculatively.
    expect(inferReadOnly('frobnicate_widget')).toBe(false);
  });

  it('agrees with the auditor’s classifier', () => {
    // The SDK duplicates these verb tables to stay dependency-free. This test
    // is what stops the two copies drifting apart.
    const asRegisteredTool = (name: string, description: string): RegisteredTool => ({
      id: name,
      name,
      description,
      inputSchema: { raw: null, type: null, propertyNames: [], required: [], isStructured: false },
      outputSchema: null,
      source: 'navigator.modelContext',
      executable: true,
      annotations: {},
      selector: null,
      manifestUrl: null,
    });

    const cases: Array<[string, string]> = [
      ['search_products', 'Search the catalog and return matching items.'],
      ['get_order_status', 'Return the fulfilment status of an order.'],
      ['track_order', 'Look up the delivery status of an order.'],
      ['filter_issues', 'Filter findings and return the matches.'],
      ['place_order', 'Place the order for the cart.'],
      ['add_to_cart', 'Add an item to the cart.'],
      ['start_return', 'Open a return request for a delivered line.'],
      ['subscribe_newsletter', 'Subscribe an email address.'],
      ['frobnicate_widget', 'Does something unusual.'],
    ];

    for (const [name, description] of cases) {
      expect(classifyTool(name, description), name).toBe(
        classifyToolByLanguage(asRegisteredTool(name, description)),
      );
    }
  });
});

describe('schema validation', () => {
  it('validates types, ranges, enums and formats', async () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: {
        email: { type: 'string', format: 'email' },
        tier: { type: 'string', enum: ['standard', 'premium'] },
        count: { type: 'integer', minimum: 1 },
        agree: { type: 'boolean' },
      },
      required: ['email'],
    };

    expect(validateAgainstJsonSchema({ email: 'a@b.co' }, schema)).toEqual([]);
    expect(validateAgainstJsonSchema({}, schema)[0]).toContain('Missing required parameter "email"');
    expect(validateAgainstJsonSchema({ email: 'nope' }, schema)[0]).toContain('must be an email');
    expect(validateAgainstJsonSchema({ email: 'a@b.co', tier: 'gold' }, schema)[0]).toContain('must be one of');
    expect(validateAgainstJsonSchema({ email: 'a@b.co', count: 0 }, schema)[0]).toContain('at least 1');
    expect(validateAgainstJsonSchema({ email: 'a@b.co', agree: 'yes' }, schema)[0]).toContain('must be a boolean');
    expect(validateAgainstJsonSchema('not an object', schema)[0]).toContain('Expected an object');
  });

  it('passes keywords it does not understand rather than rejecting them', () => {
    const schema = {
      type: 'object',
      properties: { thing: { type: 'string', someFutureKeyword: 42 } },
    } as unknown as JsonSchema;
    expect(validateAgainstJsonSchema({ thing: 'ok' }, schema)).toEqual([]);
  });

  it('accepts a predicate validator', async () => {
    const accepted = await validateArguments({ n: 2 }, { validator: () => true });
    expect(accepted.ok).toBe(true);

    const rejected = await validateArguments({ n: 2 }, { validator: () => 'must be odd' });
    expect(rejected).toEqual({ ok: false, errors: ['must be odd'] });
  });
});

/* -------------------------------------------------------------------------- */

describe('AgentForm', () => {
  function Checkout({ onSubmit, onAgentSubmit }: { onSubmit?: () => void; onAgentSubmit?: (v: unknown) => unknown }) {
    return (
      <AgentForm
        toolName="place_order"
        description="Place the order for the items in the cart."
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit?.();
        }}
        onAgentSubmit={onAgentSubmit}
        exclude={['csrf']}
      >
        <label htmlFor="email">Email address</label>
        <input id="email" name="email" type="email" required />

        <label htmlFor="qty">Quantity</label>
        <input id="qty" name="qty" type="number" />

        <label htmlFor="ship">Shipping</label>
        <select id="ship" name="ship">
          <option value="standard">Standard</option>
          <option value="express">Express</option>
        </select>

        <label htmlFor="gift">Gift wrap</label>
        <input id="gift" name="gift" type="checkbox" />

        <input type="hidden" name="csrf" value="token" />
        <button type="submit">Buy</button>
      </AgentForm>
    );
  }

  it('registers a tool whose schema mirrors the rendered fields', () => {
    render(<Checkout />);
    const tool = findTool('place_order');

    expect(tool.description).toBe('Place the order for the items in the cart.');
    // `place_*` mutates and is not easily undone.
    expect(tool.annotations.readOnlyHint).toBe(false);
    expect(tool.annotations.destructiveHint).toBe(true);

    const schema = tool.inputSchema as unknown as JsonSchema;
    expect(Object.keys(schema.properties ?? {})).toEqual(['email', 'qty', 'ship', 'gift']);
    expect(schema.properties!.email).toMatchObject({ type: 'string', format: 'email', description: 'Email address.' });
    expect(schema.properties!.qty).toMatchObject({ type: 'number', description: 'Quantity.' });
    expect(schema.properties!.ship).toMatchObject({ type: 'string', enum: ['standard', 'express'] });
    expect(schema.properties!.gift).toMatchObject({ type: 'boolean' });
    expect(schema.required).toEqual(['email']);
    // Hidden inputs and excluded names never reach the agent.
    expect(schema.properties).not.toHaveProperty('csrf');
  });

  it('fills the real inputs and submits through the form when an agent calls it', async () => {
    const onSubmit = vi.fn();
    render(<Checkout onSubmit={onSubmit} />);

    const result = await callTool('place_order', {
      email: 'buyer@example.com',
      qty: 2,
      ship: 'express',
      gift: true,
    });

    expect(result.isError).toBeUndefined();
    expect((screen.getByLabelText('Email address') as HTMLInputElement).value).toBe('buyer@example.com');
    expect((screen.getByLabelText('Quantity') as HTMLInputElement).value).toBe('2');
    expect((screen.getByLabelText('Shipping') as HTMLSelectElement).value).toBe('express');
    expect((screen.getByLabelText('Gift wrap') as HTMLInputElement).checked).toBe(true);
    // The app's own submit handler ran — one code path for humans and agents.
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('calls onAgentSubmit instead of submitting when one is supplied', async () => {
    const onSubmit = vi.fn();
    const onAgentSubmit = vi.fn(() => 'handled');
    render(<Checkout onSubmit={onSubmit} onAgentSubmit={onAgentSubmit} />);

    const result = await callTool('place_order', { email: 'a@b.co' });
    expect(onAgentSubmit).toHaveBeenCalledWith({ email: 'a@b.co' });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(result.content[0].text).toBe('handled');
  });

  it('validates against its own derived schema before touching the DOM', async () => {
    const onSubmit = vi.fn();
    render(<Checkout onSubmit={onSubmit} />);

    const result = await callTool('place_order', { email: 'not-an-email' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('must be an email address');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('unregisters when the form unmounts', () => {
    const view = render(<Checkout />);
    expect(registeredTools()).toHaveLength(1);
    view.unmount();
    expect(registeredTools()).toHaveLength(0);
  });

  it('tracks fields that appear after the first render', async () => {
    function Expanding({ showCoupon }: { showCoupon: boolean }) {
      return (
        <AgentForm toolName="place_order" description="Place the order.">
          <label htmlFor="email">Email address</label>
          <input id="email" name="email" type="email" required />
          {showCoupon ? (
            <>
              <label htmlFor="coupon">Coupon code</label>
              <input id="coupon" name="coupon" type="text" />
            </>
          ) : null}
        </AgentForm>
      );
    }

    const view = render(<Expanding showCoupon={false} />);
    expect(Object.keys((findTool('place_order').inputSchema as JsonSchema).properties ?? {})).toEqual(['email']);

    await act(async () => {
      view.rerender(<Expanding showCoupon />);
    });

    // A schema that stopped tracking the form would start lying to the agent.
    expect(Object.keys((findTool('place_order').inputSchema as JsonSchema).properties ?? {})).toEqual([
      'email',
      'coupon',
    ]);
  });

  it('honours per-field schema overrides', () => {
    render(
      <AgentForm
        toolName="search_products"
        description="Search the catalog."
        fieldOverrides={{ q: { description: 'A product name or SKU.', maxLength: 80 } }}
      >
        <input id="q" name="q" type="text" placeholder="Search" />
      </AgentForm>,
    );

    const schema = findTool('search_products').inputSchema as unknown as JsonSchema;
    expect(schema.properties!.q).toMatchObject({ description: 'A product name or SKU.', maxLength: 80 });
  });

  it('flags an unlabelled field in the schema instead of inventing a description', () => {
    render(
      <AgentForm toolName="submit_form" description="Submit the form.">
        <input name="mystery" type="text" />
      </AgentForm>,
    );

    const schema = findTool('submit_form').inputSchema as unknown as JsonSchema;
    expect(schema.properties!.mystery.description).toContain('Add a <label>');
  });

  it('treats a radio group as one enum parameter and selects the right member', async () => {
    const onAgentSubmit = vi.fn();
    render(
      <AgentForm toolName="book_seat" description="Book a seat." onAgentSubmit={onAgentSubmit}>
        <fieldset>
          <legend>Seat class</legend>
          <label htmlFor="economy">Economy</label>
          <input id="economy" name="seatClass" type="radio" value="economy" />
          <label htmlFor="business">Business</label>
          <input id="business" name="seatClass" type="radio" value="business" />
        </fieldset>
      </AgentForm>,
    );

    const schema = findTool('book_seat').inputSchema as unknown as JsonSchema;
    // One parameter, not two, and its options are the group's values.
    expect(Object.keys(schema.properties ?? {})).toEqual(['seatClass']);
    expect(schema.properties!.seatClass).toMatchObject({
      type: 'string',
      enum: ['economy', 'business'],
      description: 'Seat class.',
    });

    const result = await callTool('book_seat', { seatClass: 'business' });
    expect(result.isError).toBeUndefined();

    const economy = document.getElementById('economy') as HTMLInputElement;
    const business = document.getElementById('business') as HTMLInputElement;
    expect(business.checked).toBe(true);
    expect(economy.checked).toBe(false);
    // Writing `.value` instead of `.checked` would have corrupted this.
    expect(economy.value).toBe('economy');
    expect(onAgentSubmit).toHaveBeenCalledWith({ seatClass: 'business' });
  });

  it('rejects a radio value outside the group', async () => {
    render(
      <AgentForm toolName="book_seat" description="Book a seat.">
        <input id="a" name="seatClass" type="radio" value="economy" />
        <input id="b" name="seatClass" type="radio" value="business" />
      </AgentForm>,
    );

    const result = await callTool('book_seat', { seatClass: 'first' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('must be one of');
  });

  it('renders as an ordinary form and passes DOM props through', () => {
    render(
      <AgentForm toolName="search_products" description="Search." id="finder" className="row" registerTool={false}>
        <input name="q" />
      </AgentForm>,
    );

    const form = document.querySelector('form#finder');
    expect(form).not.toBeNull();
    expect(form!.className).toBe('row');
    expect(getModelContext()).toBeNull();
  });
});

describe('inspectForm and buildSchema', () => {
  it('reads a plain form without React', () => {
    document.body.innerHTML = `
      <form id="f">
        <label for="a">First name</label>
        <input id="a" name="first-name" type="text" required />
        <input name="b" aria-label="Second" type="url" />
        <textarea name="notes" placeholder="Anything else?"></textarea>
        <input name="skip" type="hidden" />
      </form>`;

    const form = document.getElementById('f') as HTMLFormElement;
    const fields = inspectForm(form);

    expect(fields.map((field) => field.property)).toEqual(['firstName', 'b', 'notes']);
    expect(fields[0]).toMatchObject({ label: 'First name', required: true, type: 'text' });
    expect(fields[1]).toMatchObject({ label: 'Second', type: 'url' });
    expect(fields[2]).toMatchObject({ label: 'Anything else?', tagName: 'textarea' });

    const schema = buildSchema(fields);
    expect(schema.required).toEqual(['firstName']);
    expect(schema.properties!.b).toMatchObject({ type: 'string', format: 'uri' });
    expect(schema.additionalProperties).toBe(false);
  });
});
