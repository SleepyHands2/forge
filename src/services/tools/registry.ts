import type { ToolDef } from '../../types.ts';
import { zodToJsonSchema } from './schema.ts';

const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * Holds the tools available to the agent loop. Registration validates the
 * definition eagerly (name shape, convertible params schema) so a broken tool
 * fails at boot, not mid-conversation. The registry itself is permission-blind:
 * gating happens in permissions.ts at call time.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolDef>();

  register(def: ToolDef): void {
    if (!TOOL_NAME_PATTERN.test(def.name)) {
      throw new Error(`Tool name '${def.name}' must match ${TOOL_NAME_PATTERN}`);
    }
    if (this.tools.has(def.name)) {
      throw new Error(`Tool '${def.name}' is already registered`);
    }
    if (!def.description.trim()) {
      throw new Error(`Tool '${def.name}' requires a description`);
    }
    // Fails fast on params the model-facing schema converter cannot express.
    zodToJsonSchema(def.params);
    this.tools.set(def.name, def);
  }

  get(name: string): ToolDef | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): ToolDef[] {
    return [...this.tools.values()];
  }
}
