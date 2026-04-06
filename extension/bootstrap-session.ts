import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  type ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { AgentConfig } from "./agent-discovery.js";
import { createSupportedTools, SUPPORTED_TOOL_NAMES } from "./tool-registry.js";

function resolveTools(agentConfig: AgentConfig, cwd: string) {
  return createSupportedTools(agentConfig.tools ?? SUPPORTED_TOOL_NAMES, cwd);
}

function resolveModel(agentConfig: AgentConfig, ctx: BootstrapContext): { model: Model<Api> | undefined; warnings: string[] } {
  const warnings: string[] = [];
  const model = ctx.model;
  if (!agentConfig.parsedModel) return { model, warnings };

  const found = ctx.modelRegistry.find(
    agentConfig.parsedModel.provider,
    agentConfig.parsedModel.modelId,
  );
  if (found) return { model: found, warnings };

  warnings.push(
    `Model "${agentConfig.model}" not found, using current session model`,
  );
  return { model, warnings };
}

function getSkillWarnings(
  agentConfig: AgentConfig,
  resourceLoader: DefaultResourceLoader,
): string[] {
  const warnings: string[] = [];
  if (!agentConfig.skills) return warnings;

  const availableSkillNames = new Set(
    resourceLoader.getSkills().skills.map((skill) => skill.name),
  );
  for (const skillName of agentConfig.skills) {
    if (!availableSkillNames.has(skillName)) {
      warnings.push(
        `Unknown skill "${skillName}" in subagent config, skipping`,
      );
    }
  }
  return warnings;
}

export interface BootstrapContext {
  model: Model<Api> | undefined;
  modelRegistry: ModelRegistry;
  parentSessionFile?: string;
}

interface BootstrapOptions {
  agentConfig: AgentConfig;
  cwd: string;
  ctx: BootstrapContext;
  extensionResolvedPath: string;
}

export interface BootstrapResult {
  session: AgentSession;
  warnings: string[];
}

export async function bootstrapSession(
  opts: BootstrapOptions,
): Promise<BootstrapResult> {
  const warnings: string[] = [];
  const { agentConfig, cwd, ctx, extensionResolvedPath } = opts;

  const authStorage = ctx.modelRegistry.authStorage;
  const modelRegistry = ctx.modelRegistry;
  const { model, warnings: modelWarnings } = resolveModel(agentConfig, ctx);
  warnings.push(...modelWarnings);
  const tools = resolveTools(agentConfig, cwd);

  const resourceLoader = new DefaultResourceLoader({
    cwd,
    extensionsOverride: (base) => ({
      ...base,
      extensions: base.extensions.filter(
        (ext) => !ext.resolvedPath.startsWith(extensionResolvedPath),
      ),
    }),
    skillsOverride: agentConfig.skills
      ? (base) => ({
          skills: base.skills.filter((skill) =>
            agentConfig.skills!.includes(skill.name),
          ),
          diagnostics: base.diagnostics,
        })
      : undefined,
    appendSystemPromptOverride: (base) =>
      agentConfig.systemPrompt.trim()
        ? [...base, agentConfig.systemPrompt]
        : base,
  });
  await resourceLoader.reload();
  warnings.push(...getSkillWarnings(agentConfig, resourceLoader));

  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: agentConfig.compaction ?? true },
  });

  const sessionManager = SessionManager.create(cwd);
  sessionManager.newSession({ parentSession: ctx.parentSessionFile });

  const result = await createAgentSession({
    cwd,
    model,
    thinkingLevel: agentConfig.thinking,
    tools,
    resourceLoader,
    sessionManager,
    settingsManager,
    authStorage,
    modelRegistry,
  });

  return { session: result.session, warnings };
}
