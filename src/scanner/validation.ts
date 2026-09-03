/**
 * AgentGrade — runtime conformance checks for {@link AgentAuditRawData}.
 *
 * TypeScript guarantees the shape at compile time; this module guarantees it at
 * run time, which matters because the bulk of the payload originates inside an
 * untrusted page. Consumers (the report renderer, the API) can rely on a
 * validated object rather than defensively re-checking every field.
 */

import {
  AUDIT_SCHEMA_VERSION,
  type AgentAuditRawData,
  type AuditReport,
  type TrapSeverity,
} from './types.js';

const TOOL_SOURCES = new Set([
  'navigator.modelContext',
  'document.modelContext',
  'declarative-element',
  'declarative-form',
  'well-known-mcp',
  'well-known-agent',
  'llms-txt',
]);

const TRAP_TYPES = new Set([
  'unlabelled-control',
  'opaque-iframe',
  'nested-scroll-container',
  'non-semantic-control',
  'multi-step-non-semantic',
  'unlabelled-input',
  'closed-shadow-surface',
  'pointer-only-interaction',
]);

const SEVERITIES: TrapSeverity[] = ['low', 'medium', 'high', 'critical'];

const FORM_CATEGORIES = new Set([
  'search',
  'checkout',
  'authentication',
  'signup',
  'contact',
  'newsletter',
  'filter',
  'modal-trigger',
  'generic',
]);

const NAVIGATION_STATUSES = new Set([
  'loaded',
  'timeout-soft',
  'timeout-hard',
  'network-error',
  'http-error',
  'blocked',
]);

/** The outcome of a conformance check. */
export interface ValidationResult {
  valid: boolean;
  /** Dot-paths of every violated constraint, e.g. `tools[2].inputSchema`. */
  errors: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Verifies that `value` conforms to {@link AgentAuditRawData}.
 * Structural only — it does not judge whether the audit found anything.
 */
export function validateAgentAuditRawData(value: unknown): ValidationResult {
  const errors: string[] = [];
  const fail = (path: string, reason: string): void => {
    if (errors.length < 200) errors.push(`${path}: ${reason}`);
  };

  const expectString = (path: string, input: unknown): void => {
    if (typeof input !== 'string') fail(path, `expected string, got ${typeof input}`);
  };
  const expectNullableString = (path: string, input: unknown): void => {
    if (input !== null && typeof input !== 'string') fail(path, `expected string|null, got ${typeof input}`);
  };
  const expectNumber = (path: string, input: unknown): void => {
    if (typeof input !== 'number' || !Number.isFinite(input)) fail(path, 'expected a finite number');
  };
  const expectBoolean = (path: string, input: unknown): void => {
    if (typeof input !== 'boolean') fail(path, `expected boolean, got ${typeof input}`);
  };
  const expectArray = (path: string, input: unknown): input is unknown[] => {
    if (!Array.isArray(input)) {
      fail(path, `expected array, got ${typeof input}`);
      return false;
    }
    return true;
  };
  const expectStringArray = (path: string, input: unknown): void => {
    if (!expectArray(path, input)) return;
    input.forEach((entry, index) => expectString(`${path}[${index}]`, entry));
  };

  if (!isRecord(value)) {
    return { valid: false, errors: ['root: expected an object'] };
  }

  if (value.schemaVersion !== AUDIT_SCHEMA_VERSION) {
    fail('schemaVersion', `expected "${AUDIT_SCHEMA_VERSION}", got ${JSON.stringify(value.schemaVersion)}`);
  }
  expectString('scanId', value.scanId);

  /* target ------------------------------------------------------------- */
  if (isRecord(value.target)) {
    expectString('target.requestedUrl', value.target.requestedUrl);
    expectString('target.origin', value.target.origin);
    expectString('target.startedAt', value.target.startedAt);
    expectString('target.finishedAt', value.target.finishedAt);
    expectString('target.userAgent', value.target.userAgent);
    if (isRecord(value.target.viewport)) {
      expectNumber('target.viewport.width', value.target.viewport.width);
      expectNumber('target.viewport.height', value.target.viewport.height);
    } else {
      fail('target.viewport', 'expected an object');
    }
  } else {
    fail('target', 'expected an object');
  }

  /* navigation --------------------------------------------------------- */
  if (isRecord(value.navigation)) {
    const navigation = value.navigation;
    if (typeof navigation.status !== 'string' || !NAVIGATION_STATUSES.has(navigation.status)) {
      fail('navigation.status', `unknown status ${JSON.stringify(navigation.status)}`);
    }
    expectString('navigation.requestedUrl', navigation.requestedUrl);
    expectNullableString('navigation.finalUrl', navigation.finalUrl);
    if (navigation.httpStatus !== null) expectNumber('navigation.httpStatus', navigation.httpStatus);
    expectNullableString('navigation.title', navigation.title);
    expectNumber('navigation.durationMs', navigation.durationMs);
    expectNumber('navigation.redirectCount', navigation.redirectCount);
    expectBoolean('navigation.botWallDetected', navigation.botWallDetected);
    expectStringArray('navigation.botWallSignals', navigation.botWallSignals);
    expectNullableString('navigation.error', navigation.error);
  } else {
    fail('navigation', 'expected an object');
  }

  /* page --------------------------------------------------------------- */
  if (isRecord(value.page)) {
    expectNullableString('page.title', value.page.title);
    expectNullableString('page.lang', value.page.lang);
    expectNullableString('page.description', value.page.description);
    expectNumber('page.landmarkCount', value.page.landmarkCount);
    expectBoolean('page.hasSingleMainLandmark', value.page.hasSingleMainLandmark);
    if (expectArray('page.headingLevels', value.page.headingLevels)) {
      value.page.headingLevels.forEach((level, index) => expectNumber(`page.headingLevels[${index}]`, level));
    }
    expectNumber('page.domNodeCount', value.page.domNodeCount);
    expectNumber('page.shadowRootCount', value.page.shadowRootCount);
    expectNumber('page.iframeCount', value.page.iframeCount);
    expectBoolean('page.requiresJavaScript', value.page.requiresJavaScript);
  } else {
    fail('page', 'expected an object');
  }

  /* tools -------------------------------------------------------------- */
  const validateTool = (path: string, tool: unknown): void => {
    if (!isRecord(tool)) {
      fail(path, 'expected an object');
      return;
    }
    expectString(`${path}.id`, tool.id);
    expectString(`${path}.name`, tool.name);
    expectNullableString(`${path}.description`, tool.description);
    if (typeof tool.source !== 'string' || !TOOL_SOURCES.has(tool.source)) {
      fail(`${path}.source`, `unknown source ${JSON.stringify(tool.source)}`);
    }
    expectBoolean(`${path}.executable`, tool.executable);
    expectNullableString(`${path}.selector`, tool.selector);
    expectNullableString(`${path}.manifestUrl`, tool.manifestUrl);
    if (!isRecord(tool.annotations)) fail(`${path}.annotations`, 'expected an object');
    if (isRecord(tool.inputSchema)) {
      expectNullableString(`${path}.inputSchema.type`, tool.inputSchema.type);
      expectStringArray(`${path}.inputSchema.propertyNames`, tool.inputSchema.propertyNames);
      expectStringArray(`${path}.inputSchema.required`, tool.inputSchema.required);
      expectBoolean(`${path}.inputSchema.isStructured`, tool.inputSchema.isStructured);
      if (!('raw' in tool.inputSchema)) fail(`${path}.inputSchema.raw`, 'missing');
    } else {
      fail(`${path}.inputSchema`, 'expected an object');
    }
  };

  if (expectArray('tools', value.tools)) {
    value.tools.forEach((tool, index) => validateTool(`tools[${index}]`, tool));
    const ids = (value.tools as Record<string, unknown>[]).map((tool) => tool?.id);
    if (new Set(ids).size !== ids.length) fail('tools', 'tool ids must be unique');
  }

  /* runtime ------------------------------------------------------------ */
  if (isRecord(value.runtime)) {
    expectBoolean('runtime.detected', value.runtime.detected);
    expectNumber('runtime.settleMs', value.runtime.settleMs);
    if (expectArray('runtime.probes', value.runtime.probes)) {
      if (value.runtime.probes.length !== 2) fail('runtime.probes', 'expected exactly two probes');
      value.runtime.probes.forEach((probe, index) => {
        const path = `runtime.probes[${index}]`;
        if (!isRecord(probe)) {
          fail(path, 'expected an object');
          return;
        }
        if (probe.path !== 'navigator.modelContext' && probe.path !== 'document.modelContext') {
          fail(`${path}.path`, `unknown path ${JSON.stringify(probe.path)}`);
        }
        expectBoolean(`${path}.present`, probe.present);
        expectNullableString(`${path}.valueType`, probe.valueType);
        expectStringArray(`${path}.apiSurface`, probe.apiSurface);
        expectBoolean(`${path}.supportsRegistration`, probe.supportsRegistration);
        if (expectArray(`${path}.tools`, probe.tools)) {
          probe.tools.forEach((tool, toolIndex) => validateTool(`${path}.tools[${toolIndex}]`, tool));
        }
        expectNullableString(`${path}.error`, probe.error);
      });
    }
    if (expectArray('runtime.tools', value.runtime.tools)) {
      value.runtime.tools.forEach((tool, index) => validateTool(`runtime.tools[${index}]`, tool));
    }
  } else {
    fail('runtime', 'expected an object');
  }

  /* declarative -------------------------------------------------------- */
  if (isRecord(value.declarative)) {
    if (expectArray('declarative.descriptors', value.declarative.descriptors)) {
      value.declarative.descriptors.forEach((probe, index) => {
        const path = `declarative.descriptors[${index}]`;
        if (!isRecord(probe)) {
          fail(path, 'expected an object');
          return;
        }
        expectString(`${path}.url`, probe.url);
        if (probe.kind !== 'well-known-mcp' && probe.kind !== 'well-known-agent' && probe.kind !== 'llms-txt') {
          fail(`${path}.kind`, `unknown kind ${JSON.stringify(probe.kind)}`);
        }
        expectBoolean(`${path}.found`, probe.found);
        if (probe.status !== null) expectNumber(`${path}.status`, probe.status);
        expectNullableString(`${path}.contentType`, probe.contentType);
        expectNullableString(`${path}.body`, probe.body);
        expectNumber(`${path}.byteLength`, probe.byteLength);
        expectNullableString(`${path}.error`, probe.error);
      });
    }
    if (expectArray('declarative.tags', value.declarative.tags)) {
      value.declarative.tags.forEach((tag, index) => {
        const path = `declarative.tags[${index}]`;
        if (!isRecord(tag)) {
          fail(path, 'expected an object');
          return;
        }
        expectString(`${path}.tagName`, tag.tagName);
        expectString(`${path}.selector`, tag.selector);
        expectString(`${path}.name`, tag.name);
        expectNullableString(`${path}.description`, tag.description);
        expectBoolean(`${path}.staticOnly`, tag.staticOnly);
        if (!isRecord(tag.attributes)) fail(`${path}.attributes`, 'expected an object');
      });
    }
    if (expectArray('declarative.tools', value.declarative.tools)) {
      value.declarative.tools.forEach((tool, index) => validateTool(`declarative.tools[${index}]`, tool));
    }
    if (expectArray('declarative.manifestLinks', value.declarative.manifestLinks)) {
      value.declarative.manifestLinks.forEach((link, index) => {
        const path = `declarative.manifestLinks[${index}]`;
        if (!isRecord(link)) {
          fail(path, 'expected an object');
          return;
        }
        expectString(`${path}.rel`, link.rel);
        expectString(`${path}.href`, link.href);
        expectString(`${path}.resolved`, link.resolved);
        expectNullableString(`${path}.type`, link.type);
      });
    }
  } else {
    fail('declarative', 'expected an object');
  }

  /* forms -------------------------------------------------------------- */
  const formIds = new Set<string>();
  if (expectArray('forms', value.forms)) {
    value.forms.forEach((form, index) => {
      const path = `forms[${index}]`;
      if (!isRecord(form)) {
        fail(path, 'expected an object');
        return;
      }
      expectString(`${path}.id`, form.id);
      if (typeof form.id === 'string') formIds.add(form.id);
      expectString(`${path}.tagName`, form.tagName);
      expectBoolean(`${path}.isNativeForm`, form.isNativeForm);
      expectString(`${path}.selector`, form.selector);
      expectNullableString(`${path}.name`, form.name);
      if (typeof form.category !== 'string' || !FORM_CATEGORIES.has(form.category)) {
        fail(`${path}.category`, `unknown category ${JSON.stringify(form.category)}`);
      }
      expectNullableString(`${path}.action`, form.action);
      expectNullableString(`${path}.method`, form.method);
      expectBoolean(`${path}.fullyLabelled`, form.fullyLabelled);
      expectBoolean(`${path}.inModal`, form.inModal);
      expectBoolean(`${path}.visible`, form.visible);
      expectBoolean(`${path}.mcpAnnotated`, form.mcpAnnotated);
      expectStringArray(`${path}.trapIds`, form.trapIds);
      if (expectArray(`${path}.fields`, form.fields)) {
        form.fields.forEach((field, fieldIndex) => {
          const fieldPath = `${path}.fields[${fieldIndex}]`;
          if (!isRecord(field)) {
            fail(fieldPath, 'expected an object');
            return;
          }
          expectString(`${fieldPath}.tagName`, field.tagName);
          expectString(`${fieldPath}.type`, field.type);
          expectString(`${fieldPath}.name`, field.name);
          expectString(`${fieldPath}.id`, field.id);
          expectNullableString(`${fieldPath}.accessibleName`, field.accessibleName);
          expectNullableString(`${fieldPath}.autocomplete`, field.autocomplete);
          expectBoolean(`${fieldPath}.required`, field.required);
          expectString(`${fieldPath}.selector`, field.selector);
        });
      }
      expectArray(`${path}.submitControls`, form.submitControls);
    });
  }

  expectArray('controls', value.controls);

  /* friction traps ----------------------------------------------------- */
  if (expectArray('frictionTraps', value.frictionTraps)) {
    value.frictionTraps.forEach((trap, index) => {
      const path = `frictionTraps[${index}]`;
      if (!isRecord(trap)) {
        fail(path, 'expected an object');
        return;
      }
      expectString(`${path}.id`, trap.id);
      if (typeof trap.type !== 'string' || !TRAP_TYPES.has(trap.type)) {
        fail(`${path}.type`, `unknown trap type ${JSON.stringify(trap.type)}`);
      }
      if (typeof trap.severity !== 'string' || !SEVERITIES.includes(trap.severity as TrapSeverity)) {
        fail(`${path}.severity`, `unknown severity ${JSON.stringify(trap.severity)}`);
      }
      expectString(`${path}.selector`, trap.selector);
      expectString(`${path}.tagName`, trap.tagName);
      expectString(`${path}.message`, trap.message);
      expectString(`${path}.recommendation`, trap.recommendation);
      expectNullableString(`${path}.formId`, trap.formId);
      if (typeof trap.formId === 'string' && !formIds.has(trap.formId)) {
        fail(`${path}.formId`, `references unknown form ${trap.formId}`);
      }
      if (!isRecord(trap.evidence)) fail(`${path}.evidence`, 'expected an object');
    });
  }

  /* summary ------------------------------------------------------------ */
  if (isRecord(value.summary)) {
    const summary = value.summary;
    for (const key of [
      'totalTools',
      'runtimeToolCount',
      'declarativeToolCount',
      'manifestToolCount',
      'toolsWithSchema',
      'toolsWithDescription',
      'formCount',
      'criticalFormCount',
      'fullyLabelledFormCount',
      'frictionTrapCount',
      'agentReadinessScore',
      'interactiveControlCount',
      'scanDurationMs',
      'warningCount',
      'errorCount',
    ]) {
      expectNumber(`summary.${key}`, summary[key]);
    }
    for (const key of ['hasWebMcpRuntime', 'hasWellKnownManifest', 'hasLlmsTxt']) {
      expectBoolean(`summary.${key}`, summary[key]);
    }
    if (typeof summary.agentReadinessScore === 'number') {
      if (summary.agentReadinessScore < 0 || summary.agentReadinessScore > 100) {
        fail('summary.agentReadinessScore', 'must be within 0..100');
      }
    }
    if (!['A', 'B', 'C', 'D', 'F'].includes(String(summary.grade))) {
      fail('summary.grade', `unknown grade ${JSON.stringify(summary.grade)}`);
    }
    if (isRecord(summary.trapsBySeverity)) {
      for (const severity of SEVERITIES) {
        expectNumber(`summary.trapsBySeverity.${severity}`, summary.trapsBySeverity[severity]);
      }
    } else {
      fail('summary.trapsBySeverity', 'expected an object');
    }
    if (isRecord(summary.trapsByType)) {
      for (const [key, count] of Object.entries(summary.trapsByType)) {
        if (!TRAP_TYPES.has(key)) fail(`summary.trapsByType.${key}`, 'unknown trap type');
        expectNumber(`summary.trapsByType.${key}`, count);
      }
    } else {
      fail('summary.trapsByType', 'expected an object');
    }
    if (Array.isArray(value.tools) && summary.totalTools !== value.tools.length) {
      fail('summary.totalTools', `does not match tools.length (${value.tools.length})`);
    }
    if (Array.isArray(value.forms) && summary.formCount !== value.forms.length) {
      fail('summary.formCount', `does not match forms.length (${value.forms.length})`);
    }
    if (Array.isArray(value.frictionTraps) && summary.frictionTrapCount !== value.frictionTraps.length) {
      fail('summary.frictionTrapCount', `does not match frictionTraps.length (${value.frictionTraps.length})`);
    }
  } else {
    fail('summary', 'expected an object');
  }

  /* diagnostics -------------------------------------------------------- */
  if (expectArray('diagnostics', value.diagnostics)) {
    value.diagnostics.forEach((diagnostic, index) => {
      const path = `diagnostics[${index}]`;
      if (!isRecord(diagnostic)) {
        fail(path, 'expected an object');
        return;
      }
      if (!['info', 'warning', 'error'].includes(String(diagnostic.level))) {
        fail(`${path}.level`, `unknown level ${JSON.stringify(diagnostic.level)}`);
      }
      if (!['launch', 'navigate', 'runtime', 'descriptors', 'dom', 'teardown'].includes(String(diagnostic.stage))) {
        fail(`${path}.stage`, `unknown stage ${JSON.stringify(diagnostic.stage)}`);
      }
      expectString(`${path}.code`, diagnostic.code);
      expectString(`${path}.message`, diagnostic.message);
      expectString(`${path}.at`, diagnostic.at);
    });
  }

  return { valid: errors.length === 0, errors };
}

/** Throws when `value` is not a conforming {@link AgentAuditRawData}. */
export function assertAgentAuditRawData(value: unknown): asserts value is AgentAuditRawData {
  const result = validateAgentAuditRawData(value);
  if (!result.valid) {
    throw new TypeError(
      `AgentAuditRawData conformance failed (${result.errors.length} problem(s)):\n  ${result.errors
        .slice(0, 20)
        .join('\n  ')}`,
    );
  }
}

/** Validates a whole {@link AuditReport} envelope. */
export function validateAuditReport(value: unknown): ValidationResult {
  if (!isRecord(value)) return { valid: false, errors: ['root: expected an object'] };
  const errors: string[] = [];
  if (!['ok', 'partial', 'failed'].includes(String(value.status))) {
    errors.push(`status: unknown status ${JSON.stringify(value.status)}`);
  }
  if (typeof value.generatedAt !== 'string') errors.push('generatedAt: expected string');
  if (typeof value.durationMs !== 'number' || !Number.isFinite(value.durationMs)) {
    errors.push('durationMs: expected a finite number');
  }
  const dataResult = validateAgentAuditRawData(value.data);
  errors.push(...dataResult.errors.map((error) => `data.${error}`));
  return { valid: errors.length === 0, errors };
}
