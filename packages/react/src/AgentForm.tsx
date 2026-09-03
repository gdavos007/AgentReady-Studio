'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type FormHTMLAttributes } from 'react';

import type { JsonSchema, JsonSchemaProperty } from './schema.js';
import { useWebMCP } from './useWebMCP.js';

/** One field discovered inside an {@link AgentForm}. */
export interface DiscoveredField {
  /** Schema property name, derived from `name`/`id`. */
  property: string;
  /** The element's `name` attribute, used to set the value back. */
  name: string;
  /** `input` | `select` | `textarea`. */
  tagName: string;
  /** `type` attribute for inputs. */
  type: string;
  /** Accessible name, used as the parameter description. */
  label: string | null;
  required: boolean;
  /** `<select>` option values, which become the schema's `enum`. */
  options: string[];
}

export interface AgentFormProps extends Omit<FormHTMLAttributes<HTMLFormElement>, 'onSubmit'> {
  /** Tool name. Conventionally `verb_noun`, e.g. `place_order`. */
  toolName: string;
  /** What submitting this form does, in a sentence. */
  description: string;
  /**
   * Called when an agent invokes the tool, with the collected values.
   *
   * When omitted, the agent's values are written into the real inputs and the
   * form is submitted through `requestSubmit()`, so the app's own `onSubmit`,
   * validation, and analytics all run — one code path for humans and agents.
   */
  onAgentSubmit?: (values: Record<string, unknown>) => unknown;
  /** The form's ordinary submit handler. */
  onSubmit?: FormHTMLAttributes<HTMLFormElement>['onSubmit'];
  /** Per-field schema overrides, keyed by property name. */
  fieldOverrides?: Record<string, Partial<JsonSchemaProperty>>;
  /** Field names to leave out of the tool's schema (CSRF tokens, honeypots). */
  exclude?: string[];
  /** Overrides the inferred `readOnlyHint`. */
  readOnly?: boolean;
  /** Overrides the inferred `destructiveHint`. */
  destructive?: boolean;
  /** Set `false` to render the form without registering a tool. */
  registerTool?: boolean;
  /** Notified whenever the derived schema changes. Useful in tests and dev. */
  onSchemaChange?: (schema: JsonSchema, fields: DiscoveredField[]) => void;
}

/**
 * A `<form>` that registers itself as a WebMCP tool.
 *
 * The problem this solves: an agent facing an ordinary form has to find it,
 * work out what each input wants, fill them one at a time, and find the submit
 * control — every step a chance to get it wrong. `AgentForm` inspects its own
 * rendered fields, derives a JSON Schema from their types and labels, and
 * registers a tool that accepts all the values at once.
 *
 * It stays a real form. Nothing about the human path changes, and the agent
 * path deliberately routes back through the same DOM and the same submit
 * handler rather than around them.
 */
export function AgentForm({
  toolName,
  description,
  onAgentSubmit,
  onSubmit,
  fieldOverrides,
  exclude,
  readOnly,
  destructive,
  registerTool = true,
  onSchemaChange,
  children,
  ...formProps
}: AgentFormProps) {
  const formRef = useRef<HTMLFormElement>(null);
  const [fields, setFields] = useState<DiscoveredField[]>([]);

  const excluded = useMemo(() => new Set(exclude ?? []), [exclude]);

  /**
   * Re-derives the field list from the live DOM.
   *
   * Reading the rendered form rather than the React tree means conditional
   * fields, third-party inputs, and anything rendered by a child component are
   * all discovered — a `children`-walking implementation would miss them.
   */
  const scan = useCallback(() => {
    const form = formRef.current;
    if (!form) return;

    const discovered = inspectForm(form, excluded);
    setFields((previous) => (sameFields(previous, discovered) ? previous : discovered));
  }, [excluded]);

  useEffect(() => {
    scan();
    const form = formRef.current;
    if (!form || typeof MutationObserver === 'undefined') return;

    // Forms grow and shrink — a shipping section appears, a field becomes
    // required. The registered schema has to track that or it starts lying.
    const observer = new MutationObserver(scan);
    observer.observe(form, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['name', 'type', 'required', 'aria-label', 'placeholder', 'id'],
    });
    return () => observer.disconnect();
  }, [scan, children]);

  const inputSchema = useMemo(() => buildSchema(fields, fieldOverrides), [fields, fieldOverrides]);

  useEffect(() => {
    onSchemaChange?.(inputSchema, fields);
  }, [inputSchema, fields, onSchemaChange]);

  const latestHandlers = useRef({ onAgentSubmit, fields });
  latestHandlers.current = { onAgentSubmit, fields };

  useWebMCP<Record<string, unknown>>({
    name: toolName,
    description,
    inputSchema,
    readOnly,
    destructive,
    enabled: registerTool,
    execute(values) {
      const form = formRef.current;
      if (!form) {
        return { content: [{ type: 'text' as const, text: 'Form is not mounted.' }], isError: true };
      }

      const applied = applyValues(form, latestHandlers.current.fields, values);

      const handler = latestHandlers.current.onAgentSubmit;
      if (handler) return handler(values);

      form.requestSubmit();
      return `Submitted ${toolName} with ${applied.length} field(s): ${applied.join(', ')}.`;
    },
  });

  return (
    <form ref={formRef} onSubmit={onSubmit} {...formProps}>
      {children}
    </form>
  );
}

/* -------------------------------------------------------------------------- */
/* Field inspection                                                            */
/* -------------------------------------------------------------------------- */

const FIELD_SELECTOR = 'input, select, textarea';

/** Input types that carry no agent-supplied value. */
const IGNORED_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'file']);

/** Reads a form's current fields. Exported for tests and debugging. */
export function inspectForm(
  form: HTMLFormElement,
  excluded: ReadonlySet<string> = new Set(),
): DiscoveredField[] {
  const fields: DiscoveredField[] = [];
  const seen = new Set<string>();

  for (const element of Array.from(form.querySelectorAll<HTMLElement>(FIELD_SELECTOR))) {
    const tagName = element.tagName.toLowerCase();
    const type = (element.getAttribute('type') ?? (tagName === 'input' ? 'text' : tagName)).toLowerCase();
    if (IGNORED_TYPES.has(type)) continue;

    const name = element.getAttribute('name') ?? '';
    const id = element.getAttribute('id') ?? '';
    const property = toCamelCase(name || id);
    if (!property || excluded.has(name) || excluded.has(property) || seen.has(property)) continue;

    // Radio groups share a name and describe one value between them, so the
    // group is one parameter whose options are the members' values.
    seen.add(property);

    fields.push({
      property,
      name: name || id,
      tagName,
      type,
      label: type === 'radio' ? radioGroupLabel(form, name) : accessibleName(element, form),
      required: element.hasAttribute('required') || element.getAttribute('aria-required') === 'true',
      options: collectOptions(element, form, tagName, type, name),
    });
  }

  return fields;
}

/** The selectable values a field offers: `<select>` options or a radio group. */
function collectOptions(
  element: HTMLElement,
  form: HTMLFormElement,
  tagName: string,
  type: string,
  name: string,
): string[] {
  if (tagName === 'select') {
    return Array.from((element as HTMLSelectElement).options)
      .map((option) => option.value)
      .filter((value) => value.length > 0);
  }

  if (type === 'radio' && name) {
    return Array.from(form.querySelectorAll<HTMLInputElement>(`input[type="radio"]`))
      .filter((radio) => radio.getAttribute('name') === name)
      .map((radio) => radio.value)
      .filter((value) => value.length > 0);
  }

  return [];
}

/**
 * Names a radio group.
 *
 * Each radio's own label names one *option*, not the choice being made, so the
 * group's `<fieldset><legend>` is preferred when there is one.
 */
function radioGroupLabel(form: HTMLFormElement, name: string): string | null {
  const first = form.querySelector<HTMLInputElement>(`input[type="radio"][name="${cssEscape(name)}"]`);
  if (!first) return null;

  const fieldset = first.closest('fieldset');
  const legend = fieldset?.querySelector('legend');
  if (legend?.textContent?.trim()) return collapse(legend.textContent);

  const group = first.closest('[role="radiogroup"]');
  const groupLabel = group?.getAttribute('aria-label');
  if (groupLabel?.trim()) return collapse(groupLabel);

  return null;
}

/**
 * Resolves the text a human sees for a field, in the order the accessible-name
 * computation prefers it. That text is the best available description of what
 * the parameter means, because someone already wrote it for a person.
 */
function accessibleName(element: HTMLElement, form: HTMLFormElement): string | null {
  const ariaLabel = element.getAttribute('aria-label');
  if (ariaLabel && ariaLabel.trim()) return collapse(ariaLabel);

  const labelledBy = element.getAttribute('aria-labelledby');
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => form.ownerDocument.getElementById(id)?.textContent ?? '')
      .join(' ');
    if (text.trim()) return collapse(text);
  }

  const id = element.getAttribute('id');
  if (id) {
    const label = form.querySelector(`label[for="${cssEscape(id)}"]`);
    if (label && label.textContent && label.textContent.trim()) return collapse(label.textContent);
  }

  const wrapping = element.closest('label');
  if (wrapping && wrapping.textContent && wrapping.textContent.trim()) return collapse(wrapping.textContent);

  const placeholder = element.getAttribute('placeholder');
  if (placeholder && placeholder.trim()) return collapse(placeholder);

  return null;
}

/* -------------------------------------------------------------------------- */
/* Schema derivation                                                           */
/* -------------------------------------------------------------------------- */

/** Maps an input type onto a JSON Schema type and format. */
function schemaTypeFor(field: DiscoveredField): { type: JsonSchemaProperty['type']; format?: string } {
  switch (field.type) {
    case 'email':
      return { type: 'string', format: 'email' };
    case 'url':
      return { type: 'string', format: 'uri' };
    case 'tel':
      return { type: 'string', format: 'phone' };
    case 'date':
      return { type: 'string', format: 'date' };
    case 'datetime-local':
      return { type: 'string', format: 'date-time' };
    case 'number':
    case 'range':
      return { type: 'number' };
    case 'checkbox':
      return { type: 'boolean' };
    case 'radio':
      // One of the group's values; `enum` carries the choices.
      return { type: 'string' };
    case 'password':
      return { type: 'string', format: 'password' };
    default:
      return { type: 'string' };
  }
}

/** Builds the tool's input schema from the discovered fields. */
export function buildSchema(
  fields: DiscoveredField[],
  overrides?: Record<string, Partial<JsonSchemaProperty>>,
): JsonSchema {
  const properties: Record<string, JsonSchemaProperty> = {};
  const required: string[] = [];

  for (const field of fields) {
    const { type, format } = schemaTypeFor(field);
    const property: JsonSchemaProperty = {
      type,
      description: field.label
        ? `${field.label.replace(/\s*[*:]\s*$/, '')}.`
        : `The "${field.name}" field. Add a <label> so agents and screen readers both know what it expects.`,
    };
    if (format) property.format = format;
    if (field.options.length > 0) property.enum = field.options;

    properties[field.property] = { ...property, ...overrides?.[field.property] };
    if (field.required) required.push(field.property);
  }

  return { type: 'object', properties, required, additionalProperties: false };
}

/* -------------------------------------------------------------------------- */
/* Value application                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Writes the agent's values into the real inputs.
 *
 * Uses the native value setter before dispatching `input`, because React tracks
 * the last value it wrote on the DOM node: assigning `element.value` directly
 * leaves that tracker stale and React discards the event as a no-op, so a
 * controlled input would silently keep its old value.
 */
function applyValues(
  form: HTMLFormElement,
  fields: DiscoveredField[],
  values: Record<string, unknown>,
): string[] {
  const applied: string[] = [];

  for (const field of fields) {
    if (!(field.property in values)) continue;
    const value = values[field.property];
    if (value === undefined) continue;

    // A radio group is many elements and one value: select the member whose
    // value matches. Writing `.value` on the first radio instead would leave
    // the group unselected *and* corrupt that radio's own value.
    if (field.type === 'radio') {
      const chosen = Array.from(
        form.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
      ).find((radio) => radio.getAttribute('name') === field.name && radio.value === String(value));
      if (!chosen) continue;

      setNativeChecked(chosen, true);
      chosen.dispatchEvent(new Event('input', { bubbles: true }));
      chosen.dispatchEvent(new Event('change', { bubbles: true }));
      applied.push(field.property);
      continue;
    }

    const element = form.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
      `[name="${cssEscape(field.name)}"], #${cssEscape(field.name)}`,
    );
    if (!element) continue;

    if (field.type === 'checkbox' && isCheckbox(element)) {
      setNativeChecked(element, Boolean(value));
    } else {
      setNativeValue(element, String(value));
    }

    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    applied.push(field.property);
  }

  return applied;
}

function isCheckbox(element: Element): element is HTMLInputElement {
  return element.tagName.toLowerCase() === 'input';
}

function setNativeValue(element: HTMLElement, value: string): void {
  const prototype = Object.getPrototypeOf(element) as object;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
  if (descriptor && descriptor.set) descriptor.set.call(element, value);
  else (element as { value?: string }).value = value;
}

function setNativeChecked(element: HTMLInputElement, checked: boolean): void {
  const prototype = Object.getPrototypeOf(element) as object;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'checked');
  if (descriptor && descriptor.set) descriptor.set.call(element, checked);
  else element.checked = checked;
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                               */
/* -------------------------------------------------------------------------- */

/** Compares field lists by value, so an identical rescan does not re-register. */
function sameFields(a: DiscoveredField[], b: DiscoveredField[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((field, index) => {
    const other = b[index];
    return (
      field.property === other.property &&
      field.name === other.name &&
      field.type === other.type &&
      field.label === other.label &&
      field.required === other.required &&
      field.options.join(' ') === other.options.join(' ')
    );
  });
}

function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** `card-number` → `cardNumber`. */
function toCamelCase(value: string): string {
  const words = (value ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean);
  if (words.length === 0) return '';
  return words
    .map((word, index) =>
      index === 0 ? word.toLowerCase() : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
    )
    .join('');
}

/** `CSS.escape` where available, with a conservative fallback for older jsdom. */
function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  return value.replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character}`);
}

export default AgentForm;
