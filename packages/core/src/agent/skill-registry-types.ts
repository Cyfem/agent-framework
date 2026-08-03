import type {
  AgentSkillDescriptor,
  AgentSkillFileSource,
  AgentSkillSource,
  AgentSkillSourceDiagnostic,
  AgentSkillSourceDiagnosticReason,
  SkillScriptExecutionResult,
} from './types';

/** Registry 内部保存、但不会进入模型请求的 Skill source metadata。 */
export interface ResolvedSkillSourceMetadata {
  readonly license?: string;
  readonly compatibility?: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

/** 直接以内存字符串提供的文本资源。 */
export interface ResolvedInlineSkillResource {
  readonly source: 'inline';
  readonly content: string;
}

/** File adapter 已完成初始化期校验的文本资源定位信息。 */
export interface ResolvedFileSkillResource {
  readonly source: 'file';
  readonly absolutePath: string;
  readonly realPath: string;
  readonly rootRealPath: string;
}

export type ResolvedSkillResource = ResolvedInlineSkillResource | ResolvedFileSkillResource;

/** 直接以内存源码提供、运行时需要临时物化的脚本。 */
export interface ResolvedInlineSkillScript {
  readonly source: 'inline';
  readonly extension: string;
  readonly content: string;
  readonly description?: string;
}

/** File adapter 已完成初始化期校验的脚本定位信息。 */
export interface ResolvedFileSkillScript extends ResolvedFileSkillResource {
  readonly extension: string;
  readonly description?: string;
}

export type ResolvedSkillScript = ResolvedInlineSkillScript | ResolvedFileSkillScript;

/** Source adapter 交给 Registry 做最终校验和冻结的候选 Skill。 */
export interface ResolvedSkillCandidate {
  readonly descriptor: AgentSkillDescriptor;
  readonly sourceMetadata: ResolvedSkillSourceMetadata;
  readonly instructions: string;
  readonly resources: ReadonlyMap<string, ResolvedSkillResource>;
  readonly scripts: ReadonlyMap<string, ResolvedSkillScript>;
  readonly source: 'inline' | 'file';
  readonly rootDirectory?: string;
}

/** Registry 内部不可变快照中的统一 Skill。 */
export type ResolvedSkill = ResolvedSkillCandidate;

/** File source 初始化可以加载候选，或以稳定原因安全降级。 */
export type SkillFileSourceLoadResult =
  | { readonly status: 'loaded'; readonly skill: ResolvedSkillCandidate }
  | { readonly status: 'ignored'; readonly reason: AgentSkillSourceDiagnosticReason };

/** Registry 对 file adapter 的最小依赖，具体 capability 由 Agent 闭包捕获。 */
export interface SkillRegistryFileSourceAdapter {
  load(source: AgentSkillFileSource, sourceIndex: number): SkillFileSourceLoadResult;
  read(
    resource: ResolvedFileSkillResource,
    skillName: string,
    logicalId: string,
  ): string | Promise<string>;
}

/** Registry 对脚本 runtime 的最小结构依赖。 */
export interface SkillRegistryScriptRuntime {
  isAvailable(skill: ResolvedSkill, script: ResolvedSkillScript): boolean;
  run(
    skill: ResolvedSkill,
    scriptId: string,
    script: ResolvedSkillScript,
    argv: readonly string[],
  ): Promise<SkillScriptExecutionResult>;
}

/** 构建 immutable Registry 快照所需的来源和可选运行能力。 */
export interface SkillRegistryBuildOptions {
  readonly sources: readonly AgentSkillSource[];
  readonly fileSource?: SkillRegistryFileSourceAdapter;
  readonly scriptRuntime?: SkillRegistryScriptRuntime;
}

/** Registry 与 ignored-source diagnostics 必须由 Agent 原子提交。 */
export interface SkillRegistryBuildResult {
  readonly registry: import('./skill-registry').SkillRegistry;
  readonly diagnostics: readonly AgentSkillSourceDiagnostic[];
}

/** 可纠正 Skill 工具错误的稳定 code。 */
export type SkillDispatchErrorCode =
  | 'skill_not_found'
  | 'invalid_command'
  | 'invalid_arguments'
  | 'resource_not_found'
  | 'script_not_found'
  | 'script_execution_unavailable';

/** 可作为普通 tool result 返回给模型的 Skill 调度错误。 */
export interface SkillDispatchErrorResult {
  readonly ok: false;
  readonly error: {
    readonly code: SkillDispatchErrorCode;
    readonly message: string;
  };
}

/** 不把底层路径、executable 或临时目录写入模型结果的运行阶段。 */
export type SkillRuntimeErrorStage =
  | 'resource-read'
  | 'file-validation'
  | 'materialization'
  | 'spawn'
  | 'communication';

/**
 * 文件或进程失败的脱敏 wrapper。
 *
 * 原始异常仅保存在标准 `cause` 中，公开 message 只包含已经校验过的
 * Skill 名、逻辑 id 和固定阶段。
 */
export class SkillRuntimeError extends Error {
  readonly stage: SkillRuntimeErrorStage;
  readonly skill: string;
  readonly target: string;

  constructor(stage: SkillRuntimeErrorStage, skill: string, target: string, cause: unknown) {
    super(`Skill ${stage} failed for ${skill}:${target}.`, { cause });
    this.name = 'SkillRuntimeError';
    this.stage = stage;
    this.skill = skill;
    this.target = target;
  }
}
