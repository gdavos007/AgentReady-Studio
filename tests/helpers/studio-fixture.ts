/**
 * A representative scored audit for studio tests.
 *
 * Built from the Phase 2 factory rather than a live scan, so UI and codegen
 * tests stay fast and deterministic. It deliberately contains one of each thing
 * the studio has to render: a covered surface, an uncovered critical surface,
 * traps of several types and severities, a well-formed tool, a tool with no
 * schema, and a tool mislabelled read-only.
 */

import type { AgentAuditRawData } from '../../src/scanner/types.js';
import { scoreAudit } from '../../src/evals/scorer.js';
import { runSyntheticEvaluation } from '../../src/evals/synthetic-agent.js';
import { generateAllRemediations, type RemediationBundle } from '../../src/lib/codegen.js';
import type { AgentScorecard } from '../../src/evals/types.js';
import {
  makeAuditData,
  makeDescriptors,
  makeField,
  makeForm,
  makeTool,
  makeTrap,
} from './audit-factory.js';

/** The synthetic scan the studio fixtures are built on. */
export function makeStudioAuditData(): AgentAuditRawData {
  const checkout = makeForm({
    id: 'form-1',
    category: 'checkout',
    selector: 'section#checkout',
    tagName: 'section',
    isNativeForm: false,
    method: null,
    name: 'Order summary',
    fields: [
      makeField({ name: 'coupon', id: 'coupon', accessibleName: null, labelSource: null, selector: '#coupon' }),
      makeField({
        name: 'cardNumber',
        id: 'card',
        type: 'text',
        accessibleName: 'Card number',
        required: true,
        selector: '#card',
      }),
      makeField({
        name: 'email',
        id: 'email',
        type: 'email',
        accessibleName: 'Email address',
        required: true,
        selector: '#email',
      }),
      makeField({ name: 'giftWrap', id: 'gift', type: 'checkbox', accessibleName: 'Gift wrap', selector: '#gift' }),
    ],
    trapIds: ['trap-1', 'trap-2'],
    fullyLabelled: false,
  });

  const search = makeForm({
    id: 'form-2',
    category: 'search',
    selector: 'div.search-box',
    tagName: 'div',
    isNativeForm: false,
    method: null,
    fields: [makeField({ name: 'q', id: 'site-search', type: 'search', accessibleName: 'Search products' })],
  });

  const login = makeForm({
    id: 'form-3',
    category: 'authentication',
    selector: 'form#login',
    fields: [
      makeField({ name: 'email', id: 'login-email', type: 'email', accessibleName: 'Email address', required: true }),
      makeField({
        name: 'password',
        id: 'login-password',
        type: 'password',
        accessibleName: 'Password',
        required: true,
      }),
    ],
  });

  return makeAuditData({
    scanId: 'studio-fixture-0001',
    tools: [
      makeTool({
        name: 'search_products',
        description: 'Search the catalog by free-text query and return matching items.',
        annotations: { readOnlyHint: true },
      }),
      // Registered without a schema at all.
      makeTool({
        name: 'add_to_cart',
        description: 'Add a catalog item to the cart.',
        annotations: {},
        inputSchema: { raw: null, type: null, propertyNames: [], required: [], isStructured: false },
      }),
      // Claims read-only while naming a mutation — the critical safety finding.
      makeTool({ name: 'place_order', description: 'Place the order.', annotations: { readOnlyHint: true } }),
    ],
    forms: [checkout, search, login],
    frictionTraps: [
      makeTrap({
        id: 'trap-1',
        type: 'unlabelled-input',
        severity: 'critical',
        selector: 'section#checkout > input#coupon',
        tagName: 'input',
        formId: 'form-1',
      }),
      makeTrap({
        id: 'trap-2',
        type: 'opaque-iframe',
        severity: 'critical',
        selector: 'section#checkout > iframe#payment',
        tagName: 'iframe',
        formId: 'form-1',
      }),
      makeTrap({
        id: 'trap-3',
        type: 'non-semantic-control',
        severity: 'high',
        selector: 'div.wizard > div:nth-of-type(1)',
        tagName: 'div',
      }),
      // A selector that crosses a shadow boundary, so the UI's `>>>` handling
      // is exercised by a real fixture rather than only by a unit test.
      makeTrap({
        id: 'trap-4',
        type: 'closed-shadow-surface',
        severity: 'high',
        selector: 'body > checkout-widget >>> div.pay-button',
        tagName: 'checkout-widget',
      }),
    ],
    declarative: {
      descriptors: makeDescriptors({ mcp: false, agent: false, llms: true }),
      tags: [],
      tools: [],
      manifestLinks: [],
    },
    controls: [
      {
        tagName: 'button',
        selector: 'button#cart-toggle',
        accessibleName: null,
        role: 'button',
        text: '',
        focusable: true,
        visible: true,
      },
    ],
  });
}

/** Everything a report page needs, pre-computed. */
export interface StudioFixture {
  data: AgentAuditRawData;
  scorecard: AgentScorecard;
  remediations: Record<string, RemediationBundle>;
}

/** Builds the fixture, including a synthetic evaluation trace. */
export async function makeStudioFixture(): Promise<StudioFixture> {
  const data = makeStudioAuditData();
  const syntheticEvaluation = await runSyntheticEvaluation(data, {
    goal: 'Execute product search',
    useLiveDriver: false,
  });
  const scorecard = scoreAudit(data, {
    now: () => new Date('2026-01-01T00:00:00.000Z'),
    syntheticEvaluation,
  });
  return {
    data,
    scorecard,
    remediations: Object.fromEntries(generateAllRemediations(scorecard.issues, data)),
  };
}
