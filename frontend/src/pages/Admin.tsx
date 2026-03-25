import { useContext, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';

import { ChainlitContext, useAuth } from '@chainlit/react-client';

import Alert from '@/components/Alert';
import { ThemeToggle } from '@/components/header/ThemeToggle';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { useLayoutMaxWidth } from '@/hooks/useLayoutMaxWidth';

type UserRecord = {
  id: string;
  username: string;
  email?: string;
  group_id?: string;
  display_name?: string;
  avatar_url?: string;
  is_admin?: boolean;
  overrides?: {
    allowed_models?: string[];
    model_quotas?: Record<string, number>;
    model_daily_quotas?: Record<string, number>;
  };
  usage?: Record<string, number>;
  usage_daily?: Record<string, { date?: string; count?: number }>;
};

type GroupRecord = {
  id: string;
  name: string;
  allowed_models?: string[];
  model_quotas?: Record<string, number>;
  model_daily_quotas?: Record<string, number>;
  openalex?: {
    allow_user_adjust?: boolean;
    defaults?: Record<string, any>;
    ranges?: Record<string, any>;
  };
  websearch?: {
    allow_user_adjust?: boolean;
    defaults?: Record<string, any>;
    ranges?: Record<string, any>;
  };
};

type InviteRecord = {
  code: string;
  group_id: string;
  created_at?: string;
  used?: boolean;
  used_by?: string;
  used_at?: string;
};

type AvailableModel = {
  id: string;
  label: string;
};

type ProviderType = 'openai_compat' | 'qwen_responses' | 'dashscope';
type WebsearchToolMode = 'auto' | 'on' | 'off';

type ProviderRecord = {
  id: string;
  name: string;
  type: ProviderType;
  base_url: string;
  model_prefix: string;
  priority: number;
  enabled: boolean;
  websearch_tool_mode: WebsearchToolMode;
  exposed_models?: string[];
  api_key_hint?: string;
  has_api_key?: boolean;
  created_at?: string;
  updated_at?: string;
};

type ProviderModelOption = {
  id: string;
  label: string;
  prefixed_id: string;
};

type UserDraft = {
  display_name: string;
  avatar_url: string;
  group_id: string;
  is_admin: boolean;
  allowed_models: string;
  model_quotas: string;
  model_daily_quotas: string;
};

type ModelQuotaMode = 'total' | 'daily';

type ModelConfig = {
  enabled: boolean;
  quota: string;
  mode: ModelQuotaMode;
};

type ModelConfigMap = Record<string, ModelConfig>;

type PolicyNumericValue = {
  value: number;
  min: number;
  max: number;
};

type PolicyNumericSpec = {
  key: string;
  label: string;
  defaultValue: number;
  min: number;
  max: number;
};

type PolicyFlagSpec = {
  key: string;
  label: string;
  defaultValue: boolean;
};

type GroupDraft = {
  name: string;
  allow_all_models: boolean;
  model_configs: ModelConfigMap;
  openalex_allow_user_adjust: boolean;
  openalex_numbers: Record<string, PolicyNumericValue>;
  openalex_flags: Record<string, boolean>;
  websearch_allow_user_adjust: boolean;
  websearch_numbers: Record<string, PolicyNumericValue>;
};

type ProviderDraft = {
  name: string;
  type: ProviderType;
  base_url: string;
  model_prefix: string;
  priority: string;
  enabled: boolean;
  websearch_tool_mode: WebsearchToolMode;
  exposed_models: string[];
  model_options: ProviderModelOption[];
  api_key: string;
  clear_api_key: boolean;
};

const DEFAULT_MODEL_ID = 'gpt-5.2-codex';
const DEFAULT_PROVIDER_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_DASHSCOPE_BASE_URL =
  'https://dashscope.aliyuncs.com/compatible-mode/v1';

const getDefaultProviderPrefix = (type: ProviderType): string => {
  if (type === 'qwen_responses') return 'qwen';
  if (type === 'dashscope') return 'dashscope';
  return 'openai';
};

const getDefaultProviderBaseUrl = (type: ProviderType): string => {
  if (type === 'dashscope') return DEFAULT_DASHSCOPE_BASE_URL;
  return DEFAULT_PROVIDER_BASE_URL;
};

const OPENALEX_NUMBER_SPECS: PolicyNumericSpec[] = [
  {
    key: 'openalex_per_query',
    label: 'OpenAlex 每次检索数量',
    defaultValue: 8,
    min: 1,
    max: 50
  },
  {
    key: 'openalex_top_n',
    label: 'OpenAlex Top N',
    defaultValue: 8,
    min: -1,
    max: 500
  },
  {
    key: 'openalex_max_queries',
    label: 'OpenAlex 最大查询数',
    defaultValue: 12,
    min: -1,
    max: 500
  },
  {
    key: 'openalex_bilingual_concurrency',
    label: 'OpenAlex 双语并发',
    defaultValue: 4,
    min: 1,
    max: 30
  }
];

const OPENALEX_FLAG_SPECS: PolicyFlagSpec[] = [
  {
    key: 'openalex_use_directions',
    label: '使用方向扩展',
    defaultValue: true
  },
  {
    key: 'openalex_title_zh',
    label: '标题中文化',
    defaultValue: true
  },
  {
    key: 'openalex_bilingual_zh',
    label: '双语输出',
    defaultValue: false
  },
  {
    key: 'openalex_fulltext',
    label: '优先全文模式',
    defaultValue: false
  }
];

const WEBSEARCH_NUMBER_SPECS: PolicyNumericSpec[] = [
  {
    key: 'websearch_top_n',
    label: 'WebSearch Top N',
    defaultValue: 8,
    min: 1,
    max: 10
  },
  {
    key: 'websearch_per_query',
    label: 'WebSearch 每次检索数量',
    defaultValue: 5,
    min: 1,
    max: 10
  }
];

const toFiniteNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
};

const clampInt = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, Math.round(value)));

const toBooleanValue = (value: unknown, fallback: boolean): boolean => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  }
  return fallback;
};

const buildNumericPolicyMap = (
  defaults: Record<string, any> | undefined,
  ranges: Record<string, any> | undefined,
  specs: PolicyNumericSpec[]
): Record<string, PolicyNumericValue> => {
  const result: Record<string, PolicyNumericValue> = {};
  specs.forEach((spec) => {
    const rangeSpec = ranges?.[spec.key];
    let min =
      toFiniteNumber(rangeSpec?.min) !== undefined
        ? clampInt(Number(rangeSpec.min), spec.min, spec.max)
        : spec.min;
    let max =
      toFiniteNumber(rangeSpec?.max) !== undefined
        ? clampInt(Number(rangeSpec.max), spec.min, spec.max)
        : spec.max;

    if (min > max) {
      [min, max] = [max, min];
    }

    const value =
      toFiniteNumber(defaults?.[spec.key]) !== undefined
        ? clampInt(Number(defaults?.[spec.key]), min, max)
        : clampInt(spec.defaultValue, min, max);

    result[spec.key] = { value, min, max };
  });
  return result;
};

const buildFlagPolicyMap = (
  defaults: Record<string, any> | undefined,
  specs: PolicyFlagSpec[]
): Record<string, boolean> => {
  const result: Record<string, boolean> = {};
  specs.forEach((spec) => {
    result[spec.key] = toBooleanValue(defaults?.[spec.key], spec.defaultValue);
  });
  return result;
};

const getPolicySpec = (
  scope: 'openalex' | 'websearch',
  key: string
): PolicyNumericSpec | undefined => {
  const specs = scope === 'openalex' ? OPENALEX_NUMBER_SPECS : WEBSEARCH_NUMBER_SPECS;
  return specs.find((item) => item.key === key);
};

const withPolicyNumberPatch = (
  draft: GroupDraft,
  scope: 'openalex' | 'websearch',
  key: string,
  patch: Partial<PolicyNumericValue>
): GroupDraft => {
  const target = scope === 'openalex' ? draft.openalex_numbers : draft.websearch_numbers;
  const prev = target[key];
  const spec = getPolicySpec(scope, key);
  if (!prev || !spec) return draft;

  let min = patch.min ?? prev.min;
  let max = patch.max ?? prev.max;
  let value = patch.value ?? prev.value;

  min = clampInt(min, spec.min, spec.max);
  max = clampInt(max, spec.min, spec.max);

  if (min > max) {
    if (patch.min !== undefined && patch.max === undefined) {
      max = min;
    } else if (patch.max !== undefined && patch.min === undefined) {
      min = max;
    } else {
      [min, max] = [Math.min(min, max), Math.max(min, max)];
    }
  }

  value = clampInt(value, min, max);

  const nextMap = {
    ...target,
    [key]: { value, min, max }
  };

  if (scope === 'openalex') {
    return {
      ...draft,
      openalex_numbers: nextMap
    };
  }
  return {
    ...draft,
    websearch_numbers: nextMap
  };
};

const withPolicyFlagPatch = (
  draft: GroupDraft,
  key: string,
  value: boolean
): GroupDraft => ({
  ...draft,
  openalex_flags: {
    ...draft.openalex_flags,
    [key]: value
  }
});

const buildSettingsPolicyPayload = (draft: GroupDraft) => {
  const openalexDefaults: Record<string, any> = {};
  const openalexRanges: Record<string, any> = {};
  OPENALEX_NUMBER_SPECS.forEach((spec) => {
    const value = draft.openalex_numbers[spec.key];
    if (!value) return;
    openalexDefaults[spec.key] = value.value;
    openalexRanges[spec.key] = {
      min: value.min,
      max: value.max
    };
  });
  OPENALEX_FLAG_SPECS.forEach((spec) => {
    openalexDefaults[spec.key] = !!draft.openalex_flags[spec.key];
  });

  const websearchDefaults: Record<string, any> = {};
  const websearchRanges: Record<string, any> = {};
  WEBSEARCH_NUMBER_SPECS.forEach((spec) => {
    const value = draft.websearch_numbers[spec.key];
    if (!value) return;
    websearchDefaults[spec.key] = value.value;
    websearchRanges[spec.key] = {
      min: value.min,
      max: value.max
    };
  });

  return {
    openalex: {
      allow_user_adjust: draft.openalex_allow_user_adjust,
      defaults: openalexDefaults,
      ranges: openalexRanges
    },
    websearch: {
      allow_user_adjust: draft.websearch_allow_user_adjust,
      defaults: websearchDefaults,
      ranges: websearchRanges
    }
  };
};

const createEmptyGroupDraft = (): GroupDraft => ({
  name: '',
  allow_all_models: false,
  model_configs: {
    [DEFAULT_MODEL_ID]: {
      enabled: true,
      quota: '30',
      mode: 'total'
    }
  },
  openalex_allow_user_adjust: true,
  openalex_numbers: buildNumericPolicyMap(undefined, undefined, OPENALEX_NUMBER_SPECS),
  openalex_flags: buildFlagPolicyMap(undefined, OPENALEX_FLAG_SPECS),
  websearch_allow_user_adjust: true,
  websearch_numbers: buildNumericPolicyMap(undefined, undefined, WEBSEARCH_NUMBER_SPECS)
});

const toModelList = (value: string) =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

const parseJsonField = (value: string, field: string) => {
  const trimmed = value.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch (_err) {
    throw new Error(`${field} 不是有效的 JSON`);
  }
};

const getDefaultModelConfig = (): ModelConfig => ({
  enabled: false,
  quota: '',
  mode: 'total'
});

const withModelConfigPatch = (
  draft: GroupDraft,
  modelId: string,
  patch: Partial<ModelConfig>
): GroupDraft => {
  const prevConfig = draft.model_configs[modelId] || getDefaultModelConfig();
  return {
    ...draft,
    model_configs: {
      ...draft.model_configs,
      [modelId]: {
        ...prevConfig,
        ...patch
      }
    }
  };
};

const withModelSelectAll = (
  draft: GroupDraft,
  modelIds: string[],
  enabled: boolean
): GroupDraft => {
  const modelConfigs = { ...draft.model_configs };
  modelIds.forEach((modelId) => {
    const prevConfig = modelConfigs[modelId] || getDefaultModelConfig();
    modelConfigs[modelId] = {
      ...prevConfig,
      enabled
    };
  });
  return {
    ...draft,
    model_configs: modelConfigs
  };
};

const toProviderType = (value: unknown): ProviderType => {
  if (value === 'qwen_responses') return 'qwen_responses';
  if (value === 'dashscope') return 'dashscope';
  return 'openai_compat';
};

const toWebsearchToolMode = (value: unknown): WebsearchToolMode => {
  if (value === 'on' || value === 'off') return value;
  return 'auto';
};

const dedupeProviderModels = (models: ProviderModelOption[]): ProviderModelOption[] => {
  const seen = new Set<string>();
  const result: ProviderModelOption[] = [];
  models.forEach((item) => {
    const id = String(item.id || '').trim();
    if (!id || seen.has(id)) return;
    seen.add(id);
    result.push({
      id,
      label: String(item.label || id),
      prefixed_id: String(item.prefixed_id || id)
    });
  });
  return result;
};

const buildProviderModelOptions = (
  exposedModels: string[],
  modelPrefix: string
): ProviderModelOption[] =>
  dedupeProviderModels(
    exposedModels.map((id) => ({
      id,
      label: `${modelPrefix}:${id}`,
      prefixed_id: `${modelPrefix}:${id}`
    }))
  );

const createEmptyProviderDraft = (): ProviderDraft => ({
  name: '',
  type: 'openai_compat',
  base_url: getDefaultProviderBaseUrl('openai_compat'),
  model_prefix: getDefaultProviderPrefix('openai_compat'),
  priority: '100',
  enabled: true,
  websearch_tool_mode: 'auto',
  exposed_models: [],
  model_options: [],
  api_key: '',
  clear_api_key: false
});

const initProviderDraft = (record: ProviderRecord): ProviderDraft => {
  const exposedModels = (record.exposed_models || [])
    .map((item) => String(item || '').trim())
    .filter(Boolean);
  const modelPrefix =
    String(record.model_prefix || '').trim() ||
    getDefaultProviderPrefix(toProviderType(record.type));
  return {
    name: String(record.name || record.id || '').trim(),
    type: toProviderType(record.type),
    base_url: String(record.base_url || '').trim(),
    model_prefix: modelPrefix,
    priority: String(
      Number.isFinite(Number(record.priority)) ? Number(record.priority) : 100
    ),
    enabled: record.enabled !== false,
    websearch_tool_mode: toWebsearchToolMode(record.websearch_tool_mode),
    exposed_models: exposedModels,
    model_options: buildProviderModelOptions(exposedModels, modelPrefix),
    api_key: '',
    clear_api_key: false
  };
};

const toFriendlyError = (err: unknown, fallback = '请求失败') => {
  const message = err instanceof Error ? err.message : fallback;
  if (/forbidden|403/i.test(message)) {
    return '无权限访问管理后台';
  }
  if (/unauthorized|401/i.test(message)) {
    return '登录状态已失效，请重新登录';
  }
  return message || fallback;
};

const isMissingMasterKeyError = (message: string): boolean =>
  /ACAMIND_APIKEY_MASTER_KEY/i.test(message || '');

type ModelRuleEditorProps = {
  draft: GroupDraft;
  models: AvailableModel[];
  onAllowAllChange: (checked: boolean) => void;
  onSelectAll: (enabled: boolean) => void;
  onModelToggle: (modelId: string, enabled: boolean) => void;
  onModelQuotaChange: (modelId: string, quota: string) => void;
  onModelModeChange: (modelId: string, mode: ModelQuotaMode) => void;
};
function ModelRuleEditor({
  draft,
  models,
  onAllowAllChange,
  onSelectAll,
  onModelToggle,
  onModelQuotaChange,
  onModelModeChange
}: ModelRuleEditorProps) {
  const enabledCount = Object.values(draft.model_configs).filter(
    (config) => config.enabled
  ).length;

  return (
    <div className="grid gap-4 rounded-xl border border-border/70 p-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="space-y-1">
          <Label>模型白名单与次数</Label>
          <p className="text-xs text-muted-foreground">
            {draft.allow_all_models
              ? '当前为全白名单（不限制模型），仍可对指定模型设置次数。'
              : `已选择 ${enabledCount} / ${models.length} 个模型。`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={draft.allow_all_models || models.length === 0}
            onClick={() => onSelectAll(true)}
          >
            全选
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={draft.allow_all_models || models.length === 0}
            onClick={() => onSelectAll(false)}
          >
            全不选
          </Button>
          <div className="flex items-center gap-2 rounded-md border border-input px-3 py-1.5">
            <span className="text-xs text-muted-foreground">全白名单</span>
            <Switch
              checked={draft.allow_all_models}
              onCheckedChange={onAllowAllChange}
            />
          </div>
        </div>
      </div>

      {models.length === 0 ? (
        <Alert variant="info">未读取到可用模型，请检查上游模型列表配置。</Alert>
      ) : (
        <details className="rounded-lg border border-border/60 bg-background/40">
          <summary className="cursor-pointer list-none px-3 py-2 text-sm font-medium text-muted-foreground [&::-webkit-details-marker]:hidden">
            模型列表（点击展开/收起）
          </summary>
          <div className="grid gap-2 p-2 pt-1">
            {models.map((model) => {
              const config =
                draft.model_configs[model.id] || getDefaultModelConfig();
              const disabled = draft.allow_all_models || !config.enabled;
              const showId = model.label !== model.id;

              return (
                <div
                  key={model.id}
                  className="grid gap-2 rounded-lg border border-border/60 p-3 md:grid-cols-[minmax(0,1fr)_140px_140px] md:items-center"
                >
                  <div className="flex items-start gap-3">
                    <Checkbox
                      checked={config.enabled}
                      disabled={draft.allow_all_models}
                      onCheckedChange={(checked) =>
                        onModelToggle(model.id, checked === true)
                      }
                    />
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">
                        {model.label}
                      </div>
                      {showId ? (
                        <div className="truncate text-xs text-muted-foreground">
                          {model.id}
                        </div>
                      ) : null}
                    </div>
                  </div>

                  <Input
                    value={config.quota}
                    placeholder="留空=不限"
                    disabled={disabled}
                    onChange={(event) =>
                      onModelQuotaChange(model.id, event.target.value)
                    }
                  />

                  <Select
                    value={config.mode}
                    disabled={disabled}
                    onValueChange={(value) =>
                      onModelModeChange(model.id, value as ModelQuotaMode)
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="次数类型" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="total">总次数</SelectItem>
                      <SelectItem value="daily">每日次数</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              );
            })}
          </div>
        </details>
      )}
    </div>
  );
}

type SettingsPolicyEditorProps = {
  draft: GroupDraft;
  onOpenalexAllowChange: (checked: boolean) => void;
  onWebsearchAllowChange: (checked: boolean) => void;
  onOpenalexNumberPatch: (key: string, patch: Partial<PolicyNumericValue>) => void;
  onWebsearchNumberPatch: (key: string, patch: Partial<PolicyNumericValue>) => void;
  onOpenalexFlagChange: (key: string, value: boolean) => void;
};

function SettingsPolicyEditor({
  draft,
  onOpenalexAllowChange,
  onWebsearchAllowChange,
  onOpenalexNumberPatch,
  onWebsearchNumberPatch,
  onOpenalexFlagChange
}: SettingsPolicyEditorProps) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div className="grid gap-2 md:col-span-2">
        <Label>OpenAlex 允许调整</Label>
        <div className="flex items-center justify-between rounded-md border border-input px-3 py-2">
          <span className="text-sm text-muted-foreground">
            {draft.openalex_allow_user_adjust ? '是' : '否'}
          </span>
          <Switch
            checked={draft.openalex_allow_user_adjust}
            onCheckedChange={onOpenalexAllowChange}
          />
        </div>
      </div>

      <div className="grid gap-3 md:col-span-2">
        <Label>OpenAlex 数值配置</Label>
        {OPENALEX_NUMBER_SPECS.map((spec) => {
          const value = draft.openalex_numbers[spec.key];
          if (!value) return null;
          return (
            <div
              key={spec.key}
              className="grid gap-2 rounded-lg border border-border/60 p-3"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">{spec.label}</span>
                <Input
                  type="number"
                  className="h-8 w-24"
                  value={value.value}
                  onChange={(event) => {
                    const next = Number(event.target.value);
                    if (!Number.isFinite(next)) return;
                    onOpenalexNumberPatch(spec.key, { value: next });
                  }}
                />
              </div>
              <Slider
                min={value.min}
                max={value.max}
                step={1}
                value={[value.value]}
                onValueChange={(next) =>
                  onOpenalexNumberPatch(spec.key, { value: next[0] })
                }
              />
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="flex items-center gap-2">
                  <span className="w-12 text-xs text-muted-foreground">最小</span>
                  <Input
                    type="number"
                    className="h-8"
                    value={value.min}
                    onChange={(event) => {
                      const next = Number(event.target.value);
                      if (!Number.isFinite(next)) return;
                      onOpenalexNumberPatch(spec.key, { min: next });
                    }}
                  />
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-12 text-xs text-muted-foreground">最大</span>
                  <Input
                    type="number"
                    className="h-8"
                    value={value.max}
                    onChange={(event) => {
                      const next = Number(event.target.value);
                      if (!Number.isFinite(next)) return;
                      onOpenalexNumberPatch(spec.key, { max: next });
                    }}
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="grid gap-2 md:col-span-2">
        <Label>OpenAlex 开关配置</Label>
        <div className="grid gap-2 sm:grid-cols-2">
          {OPENALEX_FLAG_SPECS.map((spec) => (
            <div
              key={spec.key}
              className="flex items-center justify-between rounded-md border border-input px-3 py-2"
            >
              <span className="text-sm text-muted-foreground">{spec.label}</span>
              <Switch
                checked={!!draft.openalex_flags[spec.key]}
                onCheckedChange={(checked) => onOpenalexFlagChange(spec.key, checked)}
              />
            </div>
          ))}
        </div>
      </div>

      <div className="grid gap-2 md:col-span-2">
        <Label>WebSearch 允许调整</Label>
        <div className="flex items-center justify-between rounded-md border border-input px-3 py-2">
          <span className="text-sm text-muted-foreground">
            {draft.websearch_allow_user_adjust ? '是' : '否'}
          </span>
          <Switch
            checked={draft.websearch_allow_user_adjust}
            onCheckedChange={onWebsearchAllowChange}
          />
        </div>
      </div>

      <div className="grid gap-3 md:col-span-2">
        <Label>WebSearch 数值配置</Label>
        {WEBSEARCH_NUMBER_SPECS.map((spec) => {
          const value = draft.websearch_numbers[spec.key];
          if (!value) return null;
          return (
            <div
              key={spec.key}
              className="grid gap-2 rounded-lg border border-border/60 p-3"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">{spec.label}</span>
                <Input
                  type="number"
                  className="h-8 w-24"
                  value={value.value}
                  onChange={(event) => {
                    const next = Number(event.target.value);
                    if (!Number.isFinite(next)) return;
                    onWebsearchNumberPatch(spec.key, { value: next });
                  }}
                />
              </div>
              <Slider
                min={value.min}
                max={value.max}
                step={1}
                value={[value.value]}
                onValueChange={(next) =>
                  onWebsearchNumberPatch(spec.key, { value: next[0] })
                }
              />
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="flex items-center gap-2">
                  <span className="w-12 text-xs text-muted-foreground">最小</span>
                  <Input
                    type="number"
                    className="h-8"
                    value={value.min}
                    onChange={(event) => {
                      const next = Number(event.target.value);
                      if (!Number.isFinite(next)) return;
                      onWebsearchNumberPatch(spec.key, { min: next });
                    }}
                  />
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-12 text-xs text-muted-foreground">最大</span>
                  <Input
                    type="number"
                    className="h-8"
                    value={value.max}
                    onChange={(event) => {
                      const next = Number(event.target.value);
                      if (!Number.isFinite(next)) return;
                      onWebsearchNumberPatch(spec.key, { max: next });
                    }}
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function Admin() {
  const { user } = useAuth();
  const apiClient = useContext(ChainlitContext);
  const layoutMaxWidth = useLayoutMaxWidth();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [groups, setGroups] = useState<GroupRecord[]>([]);
  const [invites, setInvites] = useState<InviteRecord[]>([]);
  const [availableModels, setAvailableModels] = useState<AvailableModel[]>([]);
  const [userDrafts, setUserDrafts] = useState<Record<string, UserDraft>>({});
  const [groupDrafts, setGroupDrafts] = useState<Record<string, GroupDraft>>({});
  const [newGroup, setNewGroup] = useState<GroupDraft>(createEmptyGroupDraft());
  const [isCreatingGroup, setIsCreatingGroup] = useState(false);
  const [inviteGroupId, setInviteGroupId] = useState('');
  const [providers, setProviders] = useState<ProviderRecord[]>([]);
  const [providerDrafts, setProviderDrafts] = useState<Record<string, ProviderDraft>>({});
  const [providersError, setProvidersError] = useState('');
  const [providersEncryptionReady, setProvidersEncryptionReady] = useState(true);
  const [isCreatingProvider, setIsCreatingProvider] = useState(false);
  const [newProvider, setNewProvider] =
    useState<ProviderDraft>(createEmptyProviderDraft());

  const handleProviderMutationError = (err: unknown, fallback: string): string => {
    const message = toFriendlyError(err, fallback);
    if (isMissingMasterKeyError(message)) {
      setProvidersEncryptionReady(false);
      setProvidersError('Missing ACAMIND_APIKEY_MASTER_KEY');
    }
    return message;
  };

  const fetchJSON = async (path: string, options?: RequestInit) => {
    const res = await fetch(apiClient.buildEndpoint(path), {
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...(options?.headers || {})
      },
      ...options
    });
    const contentType = res.headers.get('Content-Type') || '';
    const isJson = contentType.toLowerCase().includes('application/json');
    const json = isJson ? await res.json().catch(() => ({})) : {};
    if (!res.ok) {
      throw new Error(json?.detail || '请求失败');
    }
    if (!isJson) {
      throw new Error('接口返回了非 JSON 响应，请检查后端路由是否生效');
    }
    return json;
  };

  const initUserDraft = (record: UserRecord): UserDraft => ({
    display_name: record.display_name || record.username || '',
    avatar_url: record.avatar_url || '',
    group_id: record.group_id || 'guest',
    is_admin: !!record.is_admin,
    allowed_models: (record.overrides?.allowed_models || []).join(', '),
    model_quotas: JSON.stringify(record.overrides?.model_quotas || {}, null, 2),
    model_daily_quotas: JSON.stringify(
      record.overrides?.model_daily_quotas || {},
      null,
      2
    )
  });

  const initGroupDraft = (record: GroupRecord): GroupDraft => {
    const modelConfigs: ModelConfigMap = {};

    (record.allowed_models || []).forEach((modelId) => {
      if (!modelId) return;
      modelConfigs[modelId] = {
        enabled: true,
        quota: '',
        mode: 'total'
      };
    });

    Object.entries(record.model_quotas || {}).forEach(([modelId, quota]) => {
      if (!modelId) return;
      modelConfigs[modelId] = {
        enabled: true,
        quota: String(quota),
        mode: 'total'
      };
    });

    Object.entries(record.model_daily_quotas || {}).forEach(([modelId, quota]) => {
      if (!modelId) return;
      modelConfigs[modelId] = {
        enabled: true,
        quota: String(quota),
        mode: 'daily'
      };
    });

    return {
      name: record.name || record.id,
      allow_all_models: (record.allowed_models || []).length === 0,
      model_configs: modelConfigs,
      openalex_allow_user_adjust: record.openalex?.allow_user_adjust ?? true,
      openalex_numbers: buildNumericPolicyMap(
        record.openalex?.defaults,
        record.openalex?.ranges,
        OPENALEX_NUMBER_SPECS
      ),
      openalex_flags: buildFlagPolicyMap(
        record.openalex?.defaults,
        OPENALEX_FLAG_SPECS
      ),
      websearch_allow_user_adjust: record.websearch?.allow_user_adjust ?? true,
      websearch_numbers: buildNumericPolicyMap(
        record.websearch?.defaults,
        record.websearch?.ranges,
        WEBSEARCH_NUMBER_SPECS
      )
    };
  };

  const normalizeProviderRecord = (raw: any): ProviderRecord => {
    const providerId = String(raw?.id || '').trim();
    const providerType = toProviderType(raw?.type);
    const defaultPrefix = getDefaultProviderPrefix(providerType);
    return {
      id: providerId,
      name: String(raw?.name || providerId).trim() || providerId,
      type: providerType,
      base_url:
        String(raw?.base_url || '').trim() ||
        getDefaultProviderBaseUrl(providerType),
      model_prefix: String(raw?.model_prefix || defaultPrefix).trim() || defaultPrefix,
      priority: Number.isFinite(Number(raw?.priority)) ? Number(raw.priority) : 100,
      enabled: raw?.enabled !== false,
      websearch_tool_mode: toWebsearchToolMode(raw?.websearch_tool_mode),
      exposed_models: Array.isArray(raw?.exposed_models)
        ? raw.exposed_models
            .map((item: any) => String(item || '').trim())
            .filter(Boolean)
        : [],
      api_key_hint: String(raw?.api_key_hint || '').trim(),
      has_api_key: !!raw?.has_api_key,
      created_at: String(raw?.created_at || ''),
      updated_at: String(raw?.updated_at || '')
    };
  };

  const buildModelCatalog = (draft?: GroupDraft, record?: GroupRecord) => {
    const modelMap = new Map<string, string>();

    availableModels.forEach((model) => {
      const id = String(model.id || '').trim();
      if (!id) return;
      modelMap.set(id, model.label || id);
    });

    const addModelId = (id: string) => {
      const modelId = String(id || '').trim();
      if (!modelId || modelMap.has(modelId)) return;
      modelMap.set(modelId, `${modelId}（已配置）`);
    };

    (record?.allowed_models || []).forEach(addModelId);
    Object.keys(record?.model_quotas || {}).forEach(addModelId);
    Object.keys(record?.model_daily_quotas || {}).forEach(addModelId);
    Object.keys(draft?.model_configs || {}).forEach(addModelId);

    return Array.from(modelMap.entries()).map(([id, label]) => ({ id, label }));
  };

  const buildGroupModelPayload = (draft: GroupDraft) => {
    const allowedModels: string[] = [];
    const modelQuotas: Record<string, number> = {};
    const modelDailyQuotas: Record<string, number> = {};

    Object.entries(draft.model_configs || {}).forEach(([modelId, config]) => {
      if (!modelId || !config?.enabled) return;

      if (!draft.allow_all_models) {
        allowedModels.push(modelId);
      }

      const quotaRaw = String(config.quota || '').trim();
      if (!quotaRaw) {
        return;
      }

      const quota = Number(quotaRaw);
      if (!Number.isInteger(quota)) {
        throw new Error(`模型 ${modelId} 的次数必须是整数`);
      }

      if (config.mode === 'daily') {
        modelDailyQuotas[modelId] = quota;
      } else {
        modelQuotas[modelId] = quota;
      }
    });

    return {
      allowed_models: draft.allow_all_models ? [] : allowedModels,
      model_quotas: modelQuotas,
      model_daily_quotas: modelDailyQuotas
    };
  };

  const refreshAll = async () => {
    setLoading(true);
    setError('');
    try {
      const [usersRes, groupsRes, invitesRes, modelsRes, providersRes] =
        await Promise.all([
        fetchJSON('/admin/users'),
        fetchJSON('/admin/groups'),
        fetchJSON('/admin/invites'),
        fetchJSON('/admin/models').catch(() => ({ models: [] })),
        fetchJSON('/admin/providers')
          .then((payload) => ({ ok: true, payload }))
          .catch((err) => ({
            ok: false,
            error: toFriendlyError(err, '加载 API Keys 失败')
          }))
      ]);

      const nextUsers = usersRes?.users || [];
      const nextGroups = groupsRes?.groups || [];
      const nextInvites = invitesRes?.invites || [];
      const rawModels = Array.isArray(modelsRes?.models) ? modelsRes.models : [];
      const providerResult = providersRes as
        | { ok: true; payload: any }
        | { ok: false; error: string };

      const seenModelIds = new Set<string>();
      const nextModels: AvailableModel[] = [];
      rawModels.forEach((item: any) => {
        const id = String(item?.id || item || '').trim();
        if (!id || seenModelIds.has(id)) return;
        seenModelIds.add(id);
        nextModels.push({
          id,
          label: String(item?.label || item?.id || id)
        });
      });

      setUsers(nextUsers);
      setGroups(nextGroups);
      setInvites(nextInvites);
      setAvailableModels(nextModels);

      const userDraftMap: Record<string, UserDraft> = {};
      nextUsers.forEach((record: UserRecord) => {
        userDraftMap[record.id] = initUserDraft(record);
      });
      setUserDrafts(userDraftMap);

      const groupDraftMap: Record<string, GroupDraft> = {};
      nextGroups.forEach((record: GroupRecord) => {
        groupDraftMap[record.id] = initGroupDraft(record);
      });
      setGroupDrafts(groupDraftMap);

        if (providerResult.ok) {
          const rawProviders = Array.isArray(providerResult.payload?.providers)
            ? providerResult.payload.providers
            : [];
        const encryptionReady = providerResult.payload?.encryption_ready !== false;
        setProvidersEncryptionReady(encryptionReady);
        const nextProviders = rawProviders
          .map((item: any) => normalizeProviderRecord(item))
          .filter((item: ProviderRecord) => item.id)
          .sort((a: ProviderRecord, b: ProviderRecord) => {
            if (a.priority !== b.priority) return a.priority - b.priority;
            return a.id.localeCompare(b.id);
          });
        const providerDraftMap: Record<string, ProviderDraft> = {};
        nextProviders.forEach((record: ProviderRecord) => {
          providerDraftMap[record.id] = initProviderDraft(record);
        });
        setProviders(nextProviders);
        setProviderDrafts(providerDraftMap);
        if (encryptionReady) {
          setProvidersError('');
        } else {
          setProvidersError(
            String(
              providerResult.payload?.encryption_error ||
                'Missing ACAMIND_APIKEY_MASTER_KEY'
            )
          );
        }
      } else {
        setProviders([]);
        setProviderDrafts({});
        setProvidersEncryptionReady(false);
        setProvidersError(providerResult.error || '加载 API Keys 失败');
      }

      if (!inviteGroupId && nextGroups.length) {
        setInviteGroupId(nextGroups[0].id);
      }
    } catch (err) {
      setError(toFriendlyError(err, '加载失败'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!user) return;
    refreshAll();
  }, [user]);

  useEffect(() => {
    if (isMissingMasterKeyError(providersError)) {
      setProvidersEncryptionReady(false);
    }
  }, [providersError]);

  const handleUpdateUserDraft = (userId: string, patch: Partial<UserDraft>) => {
    setUserDrafts((prev) => ({ ...prev, [userId]: { ...prev[userId], ...patch } }));
  };

  const handleSaveUser = async (record: UserRecord) => {
    const draft = userDrafts[record.id];
    if (!draft) return;
    try {
      const payload = {
        display_name: draft.display_name.trim(),
        avatar_url: draft.avatar_url.trim(),
        group_id: draft.group_id,
        is_admin: draft.is_admin,
        allowed_models: toModelList(draft.allowed_models),
        model_quotas: parseJsonField(draft.model_quotas, '模型总次数覆盖'),
        model_daily_quotas: parseJsonField(
          draft.model_daily_quotas,
          '模型每日次数覆盖'
        )
      };
      const res = await fetchJSON(`/admin/users/${record.id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload)
      });
      const nextUser = res?.user;
      if (nextUser) {
        setUsers((prev) =>
          prev.map((item) => (item.id === nextUser.id ? nextUser : item))
        );
        setUserDrafts((prev) => ({
          ...prev,
          [nextUser.id]: initUserDraft(nextUser)
        }));
      }
      toast.success('用户已更新');
    } catch (err) {
      toast.error(toFriendlyError(err, '更新失败'));
    }
  };

  const handleUpdateGroupDraft = (
    groupId: string,
    patch: Partial<GroupDraft>
  ) => {
    setGroupDrafts((prev) => ({ ...prev, [groupId]: { ...prev[groupId], ...patch } }));
  };

  const handleUpdateGroupModel = (
    groupId: string,
    modelId: string,
    patch: Partial<ModelConfig>
  ) => {
    setGroupDrafts((prev) => {
      const draft = prev[groupId];
      if (!draft) return prev;
      return {
        ...prev,
        [groupId]: withModelConfigPatch(draft, modelId, patch)
      };
    });
  };

  const handleSelectAllGroupModels = (groupId: string, enabled: boolean) => {
    setGroupDrafts((prev) => {
      const draft = prev[groupId];
      if (!draft) return prev;
      const record = groups.find((item) => item.id === groupId);
      const modelIds = buildModelCatalog(draft, record).map((item) => item.id);
      return {
        ...prev,
        [groupId]: withModelSelectAll(draft, modelIds, enabled)
      };
    });
  };

  const handleUpdateNewGroupModel = (
    modelId: string,
    patch: Partial<ModelConfig>
  ) => {
    setNewGroup((prev) => withModelConfigPatch(prev, modelId, patch));
  };

  const handleSelectAllNewGroupModels = (enabled: boolean) => {
    setNewGroup((prev) => {
      const modelIds = buildModelCatalog(prev).map((item) => item.id);
      return withModelSelectAll(prev, modelIds, enabled);
    });
  };

  const handleUpdateGroupPolicyNumber = (
    groupId: string,
    scope: 'openalex' | 'websearch',
    key: string,
    patch: Partial<PolicyNumericValue>
  ) => {
    setGroupDrafts((prev) => {
      const draft = prev[groupId];
      if (!draft) return prev;
      return {
        ...prev,
        [groupId]: withPolicyNumberPatch(draft, scope, key, patch)
      };
    });
  };

  const handleUpdateNewGroupPolicyNumber = (
    scope: 'openalex' | 'websearch',
    key: string,
    patch: Partial<PolicyNumericValue>
  ) => {
    setNewGroup((prev) => withPolicyNumberPatch(prev, scope, key, patch));
  };

  const handleUpdateGroupPolicyFlag = (
    groupId: string,
    key: string,
    value: boolean
  ) => {
    setGroupDrafts((prev) => {
      const draft = prev[groupId];
      if (!draft) return prev;
      return {
        ...prev,
        [groupId]: withPolicyFlagPatch(draft, key, value)
      };
    });
  };

  const handleUpdateNewGroupPolicyFlag = (key: string, value: boolean) => {
    setNewGroup((prev) => withPolicyFlagPatch(prev, key, value));
  };

  const handleStartCreateGroup = () => {
    setNewGroup(createEmptyGroupDraft());
    setIsCreatingGroup(true);
  };

  const handleSaveGroup = async (record: GroupRecord) => {
    const draft = groupDrafts[record.id];
    if (!draft) return;
    try {
      const modelPayload = buildGroupModelPayload(draft);
      const settingsPayload = buildSettingsPolicyPayload(draft);
      const payload = {
        name: draft.name.trim() || record.name,
        ...modelPayload,
        ...settingsPayload
      };
      const res = await fetchJSON(`/admin/groups/${record.id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload)
      });
      const nextGroup = res?.group;
      if (nextGroup) {
        setGroups((prev) =>
          prev.map((item) => (item.id === nextGroup.id ? nextGroup : item))
        );
        setGroupDrafts((prev) => ({
          ...prev,
          [nextGroup.id]: initGroupDraft(nextGroup)
        }));
      }
      toast.success('权限组已更新');
    } catch (err) {
      toast.error(toFriendlyError(err, '更新失败'));
    }
  };

  const handleCreateGroup = async () => {
    try {
      const modelPayload = buildGroupModelPayload(newGroup);
      const settingsPayload = buildSettingsPolicyPayload(newGroup);
      const payload = {
        name: newGroup.name.trim() || '新权限组',
        ...modelPayload,
        ...settingsPayload
      };
      const res = await fetchJSON('/admin/groups', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      const nextGroup = res?.group;
      if (nextGroup) {
        setGroups((prev) => [...prev, nextGroup]);
        setGroupDrafts((prev) => ({
          ...prev,
          [nextGroup.id]: initGroupDraft(nextGroup)
        }));
        setNewGroup(createEmptyGroupDraft());
        setIsCreatingGroup(false);
      }
      toast.success('权限组已创建');
    } catch (err) {
      toast.error(toFriendlyError(err, '创建失败'));
    }
  };

  const handleCopyGroup = async (record: GroupRecord) => {
    const draft = groupDrafts[record.id] || initGroupDraft(record);
    try {
      const modelPayload = buildGroupModelPayload(draft);
      const settingsPayload = buildSettingsPolicyPayload(draft);
      const payload = {
        name: `${(draft.name || record.name || record.id).trim()}复制`,
        ...modelPayload,
        ...settingsPayload
      };
      const res = await fetchJSON('/admin/groups', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      const nextGroup = res?.group;
      if (nextGroup) {
        setGroups((prev) => [...prev, nextGroup]);
        setGroupDrafts((prev) => ({
          ...prev,
          [nextGroup.id]: initGroupDraft(nextGroup)
        }));
      }
      toast.success('权限组已复制');
    } catch (err) {
      toast.error(toFriendlyError(err, '复制失败'));
    }
  };

  const handleCreateInvite = async () => {
    if (!inviteGroupId) {
      toast.error('请选择权限组');
      return;
    }
    try {
      const res = await fetchJSON('/admin/invites', {
        method: 'POST',
        body: JSON.stringify({ group_id: inviteGroupId })
      });
      const invite = res?.invite;
      if (invite) {
        setInvites((prev) => [invite, ...prev]);
      }
      toast.success('邀请码已创建');
    } catch (err) {
      toast.error(toFriendlyError(err, '创建失败'));
    }
  };

  const handleDeleteInvite = async (code: string) => {
    try {
      await fetchJSON(`/admin/invites/${code}`, { method: 'DELETE' });
      setInvites((prev) => prev.filter((item) => item.code !== code));
      toast.success('邀请码已删除');
    } catch (err) {
      toast.error(toFriendlyError(err, '删除失败'));
    }
  };

  const handleDeleteUser = async (record: UserRecord) => {
    const confirmText = `确认删除用户 ${record.username} 吗？`;
    if (!window.confirm(confirmText)) return;
    try {
      await fetchJSON(`/admin/users/${record.id}`, { method: 'DELETE' });
      setUsers((prev) => prev.filter((item) => item.id !== record.id));
      setUserDrafts((prev) => {
        const next = { ...prev };
        delete next[record.id];
        return next;
      });
      toast.success('用户已删除');
    } catch (err) {
      toast.error(toFriendlyError(err, '删除失败'));
    }
  };

  const handleDeleteGroup = async (record: GroupRecord) => {
    const groupId = String(record.id || '').trim();
    if (!groupId) return;
    if (groupId === 'admin' || groupId === 'guest') {
      toast.error('默认权限组不可删除');
      return;
    }
    const confirmText = `确认删除权限组 ${record.name} 吗？该组用户将迁移到访客权限组。`;
    if (!window.confirm(confirmText)) return;
    try {
      await fetchJSON(`/admin/groups/${groupId}`, { method: 'DELETE' });
      await refreshAll();
      toast.success('权限组已删除');
    } catch (err) {
      toast.error(toFriendlyError(err, '删除失败'));
    }
  };

  const handleUpdateProviderDraft = (
    providerId: string,
    patch: Partial<ProviderDraft>
  ) => {
    setProviderDrafts((prev) => ({
      ...prev,
      [providerId]: { ...prev[providerId], ...patch }
    }));
  };

  const handleToggleProviderModel = (
    providerId: string,
    modelId: string,
    enabled: boolean
  ) => {
    setProviderDrafts((prev) => {
      const draft = prev[providerId];
      if (!draft) return prev;
      const current = new Set(draft.exposed_models || []);
      if (enabled) {
        current.add(modelId);
      } else {
        current.delete(modelId);
      }
      return {
        ...prev,
        [providerId]: {
          ...draft,
          exposed_models: Array.from(current)
        }
      };
    });
  };

  const handleSelectAllProviderModels = (providerId: string, enabled: boolean) => {
    setProviderDrafts((prev) => {
      const draft = prev[providerId];
      if (!draft) return prev;
      if (!enabled) {
        return {
          ...prev,
          [providerId]: {
            ...draft,
            exposed_models: []
          }
        };
      }
      return {
        ...prev,
        [providerId]: {
          ...draft,
          exposed_models: draft.model_options.map((item) => item.id)
        }
      };
    });
  };

  const handleStartCreateProvider = () => {
    const seedModels = dedupeProviderModels(
      availableModels.map((item) => {
        const modelId = String(item.id || '').trim();
        const raw = modelId.includes(':') ? modelId.split(':', 2)[1] : modelId;
        return {
          id: raw,
          label: String(item.label || modelId || raw),
          prefixed_id: `openai:${raw}`
        };
      })
    );
    setNewProvider({
      ...createEmptyProviderDraft(),
      model_options: seedModels
    });
    setIsCreatingProvider(true);
  };

  const handleToggleNewProviderModel = (modelId: string, enabled: boolean) => {
    setNewProvider((prev) => {
      const current = new Set(prev.exposed_models || []);
      if (enabled) {
        current.add(modelId);
      } else {
        current.delete(modelId);
      }
      return {
        ...prev,
        exposed_models: Array.from(current)
      };
    });
  };

  const handleSelectAllNewProviderModels = (enabled: boolean) => {
    if (!enabled) {
      setNewProvider((prev) => ({ ...prev, exposed_models: [] }));
      return;
    }
    setNewProvider((prev) => ({
      ...prev,
      exposed_models: prev.model_options.map((item) => item.id)
    }));
  };

  const handleRefreshProviderModels = async (providerId: string) => {
    try {
      const res = await fetchJSON(`/admin/providers/${providerId}/models/refresh`, {
        method: 'POST'
      });
      const rawModels = Array.isArray(res?.models) ? res.models : [];
      const modelPrefix =
        String(res?.model_prefix || providerDrafts[providerId]?.model_prefix || '').trim() ||
        'openai';
      const refreshed = dedupeProviderModels(
        rawModels.map((item: any) => ({
          id: String(item?.id || '').trim(),
          label: String(item?.label || item?.id || '').trim(),
          prefixed_id: String(
            item?.prefixed_id || `${modelPrefix}:${String(item?.id || '').trim()}`
          ).trim()
        }))
      );
      setProviderDrafts((prev) => {
        const draft = prev[providerId];
        if (!draft) return prev;
        const refreshedIds = new Set(refreshed.map((item) => item.id));
        const preserved = draft.exposed_models
          .filter((item) => !refreshedIds.has(item))
          .map((item) => ({
            id: item,
            label: `${draft.model_prefix}:${item}`,
            prefixed_id: `${draft.model_prefix}:${item}`
          }));
        return {
          ...prev,
          [providerId]: {
            ...draft,
            model_options: dedupeProviderModels([...refreshed, ...preserved])
          }
        };
      });
      toast.success('模型列表已刷新');
    } catch (err) {
      toast.error(toFriendlyError(err, '刷新模型失败'));
    }
  };

  const handleSaveProvider = async (record: ProviderRecord) => {
    const draft = providerDrafts[record.id];
    if (!draft) return;
    try {
      const priority = Number(draft.priority);
      const payload: Record<string, any> = {
        name: draft.name.trim() || record.name || record.id,
        type: toProviderType(draft.type),
        base_url: draft.base_url.trim(),
        model_prefix:
          draft.model_prefix.trim() ||
          getDefaultProviderPrefix(draft.type),
        priority: Number.isFinite(priority) ? Math.trunc(priority) : 100,
        enabled: !!draft.enabled,
        websearch_tool_mode: toWebsearchToolMode(draft.websearch_tool_mode),
        exposed_models: (draft.exposed_models || []).map((item) => item.trim()).filter(Boolean)
      };
      if (draft.clear_api_key) {
        payload.api_key = '';
      } else if (draft.api_key.trim()) {
        payload.api_key = draft.api_key.trim();
      }
      await fetchJSON(`/admin/providers/${record.id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload)
      });
      await refreshAll();
      toast.success('API Key 已更新');
    } catch (err) {
      toast.error(handleProviderMutationError(err, '更新失败'));
    }
  };

  const handleCreateProvider = async () => {
    try {
      if (!newProvider.api_key.trim()) {
        toast.error('请填写 API Key');
        return;
      }
      const priority = Number(newProvider.priority);
      const payload = {
        name: newProvider.name.trim() || 'provider',
        type: toProviderType(newProvider.type),
        base_url:
          newProvider.base_url.trim() ||
          getDefaultProviderBaseUrl(newProvider.type),
        model_prefix:
          newProvider.model_prefix.trim() ||
          getDefaultProviderPrefix(newProvider.type),
        priority: Number.isFinite(priority) ? Math.trunc(priority) : 100,
        enabled: !!newProvider.enabled,
        websearch_tool_mode: toWebsearchToolMode(newProvider.websearch_tool_mode),
        exposed_models: (newProvider.exposed_models || [])
          .map((item) => item.trim())
          .filter(Boolean),
        api_key: newProvider.api_key.trim()
      };
      await fetchJSON('/admin/providers', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      setIsCreatingProvider(false);
      setNewProvider(createEmptyProviderDraft());
      await refreshAll();
      toast.success('API Key 已创建');
    } catch (err) {
      toast.error(handleProviderMutationError(err, '创建失败'));
    }
  };

  const handleDeleteProvider = async (record: ProviderRecord) => {
    const providerId = String(record.id || '').trim();
    if (!providerId) return;
    if (!window.confirm(`确认删除 API Key ${record.name || providerId} 吗？`)) return;
    try {
      await fetchJSON(`/admin/providers/${providerId}`, { method: 'DELETE' });
      await refreshAll();
      toast.success('API Key 已删除');
    } catch (err) {
      toast.error(handleProviderMutationError(err, '删除失败'));
    }
  };

  const groupOptions = useMemo(
    () => groups.map((group) => ({ value: group.id, label: group.name })),
    [groups]
  );

  const providerModelSeedsByPrefix = useMemo(() => {
    const seedMap = new Map<string, ProviderModelOption[]>();
    availableModels.forEach((item) => {
      const modelId = String(item.id || '').trim();
      if (!modelId) return;
      const [prefixRaw, rawMaybe] = modelId.includes(':')
        ? modelId.split(':', 2)
        : ['', modelId];
      const prefix = String(prefixRaw || '').trim().toLowerCase();
      const raw = String(rawMaybe || '').trim();
      if (!prefix || !raw) return;
      const exists = seedMap.get(prefix) || [];
      exists.push({
        id: raw,
        label: String(item.label || modelId),
        prefixed_id: modelId
      });
      seedMap.set(prefix, dedupeProviderModels(exists));
    });
    return seedMap;
  }, [availableModels]);

  const usersByGroup = useMemo(() => {
    const groupNameMap = new Map<string, string>();
    groups.forEach((group) => {
      const id = String(group.id || '').trim();
      if (!id) return;
      groupNameMap.set(id, String(group.name || id));
    });

    const grouped = new Map<string, UserRecord[]>();
    users.forEach((record) => {
      const groupId = String(record.group_id || 'guest').trim() || 'guest';
      const items = grouped.get(groupId);
      if (items) {
        items.push(record);
      } else {
        grouped.set(groupId, [record]);
      }
    });

    const orderedGroupIds: string[] = [];
    groups.forEach((group) => {
      const groupId = String(group.id || '').trim();
      if (!groupId || !grouped.has(groupId)) return;
      orderedGroupIds.push(groupId);
    });
    Array.from(grouped.keys())
      .filter((groupId) => !orderedGroupIds.includes(groupId))
      .sort()
      .forEach((groupId) => orderedGroupIds.push(groupId));

    return orderedGroupIds.map((groupId) => ({
      groupId,
      groupName: groupNameMap.get(groupId) || groupId,
      users: grouped.get(groupId) || []
    }));
  }, [groups, users]);

  if (!user) return null;

  return (
    <div className="h-[100dvh] min-h-[100svh] overflow-y-auto overscroll-y-contain pb-[calc(env(safe-area-inset-bottom)+5rem)] font-acamind">
      <div className="fixed right-4 top-4 z-50 sm:right-6 sm:top-6">
        <ThemeToggle className="rounded-full border border-border bg-background/85 shadow-sm backdrop-blur" />
      </div>
      <div
        className="mx-auto flex min-h-full w-full flex-col gap-6 p-4 pb-10 md:p-6 md:pb-12"
        style={{ maxWidth: layoutMaxWidth }}
      >
        <div className="relative overflow-hidden rounded-3xl border border-slate-200/60 bg-white/80 p-6 shadow-[0_20px_60px_rgba(15,23,42,0.08)] backdrop-blur dark:border-white/5 dark:bg-slate-950/70">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,_rgba(22,200,242,0.2),_transparent_60%)]" />
          <div className="relative flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <h1 className="text-2xl font-semibold">管理后台</h1>
              <p className="text-sm text-slate-600 dark:text-slate-300">
                管理用户、权限组、API Keys 与邀请码配置。
              </p>
            </div>
            <div className="flex items-center gap-3">
              <Button variant="outline" onClick={refreshAll} disabled={loading}>
                刷新
              </Button>
              <Button onClick={() => navigate('/')}>返回首页</Button>
            </div>
          </div>
          <div className="relative mt-6 grid gap-3 md:grid-cols-4">
            <div className="rounded-2xl border border-slate-200/70 bg-white/70 p-4 text-sm shadow-sm dark:border-white/5 dark:bg-slate-900/60">
              <p className="text-slate-500 dark:text-slate-400">用户</p>
              <p className="mt-2 text-2xl font-semibold">{users.length}</p>
            </div>
            <div className="rounded-2xl border border-slate-200/70 bg-white/70 p-4 text-sm shadow-sm dark:border-white/5 dark:bg-slate-900/60">
              <p className="text-slate-500 dark:text-slate-400">权限组</p>
              <p className="mt-2 text-2xl font-semibold">{groups.length}</p>
            </div>
            <div className="rounded-2xl border border-slate-200/70 bg-white/70 p-4 text-sm shadow-sm dark:border-white/5 dark:bg-slate-900/60">
              <p className="text-slate-500 dark:text-slate-400">API Keys</p>
              <p className="mt-2 text-2xl font-semibold">{providers.length}</p>
            </div>
            <div className="rounded-2xl border border-slate-200/70 bg-white/70 p-4 text-sm shadow-sm dark:border-white/5 dark:bg-slate-900/60">
              <p className="text-slate-500 dark:text-slate-400">邀请码</p>
              <p className="mt-2 text-2xl font-semibold">{invites.length}</p>
            </div>
          </div>
        </div>

        {error ? <Alert variant="error">{error}</Alert> : null}

        <Tabs defaultValue="users" className="w-full">
          <TabsList className="grid w-full grid-cols-4 rounded-2xl bg-slate-100/70 p-1 dark:bg-slate-900/70">
            <TabsTrigger value="users">用户</TabsTrigger>
            <TabsTrigger value="groups">权限组</TabsTrigger>
            <TabsTrigger value="providers">API Keys</TabsTrigger>
            <TabsTrigger value="invites">邀请码</TabsTrigger>
          </TabsList>

          <TabsContent value="users" className="space-y-4">
            {users.length === 0 && !loading ? (
              <Alert variant="info">暂无用户</Alert>
            ) : null}
            {usersByGroup.map((groupBucket) => (
              <details
                key={groupBucket.groupId}
                className="rounded-xl border border-border/70 bg-card/50"
              >
                <summary className="list-none cursor-pointer px-4 py-3 [&::-webkit-details-marker]:hidden">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-sm font-semibold">
                      {groupBucket.groupName}
                      <span className="ml-2 text-xs text-muted-foreground">
                        ({groupBucket.users.length})
                      </span>
                    </div>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      点击展开/收起
                    </span>
                  </div>
                </summary>
                <div className="space-y-3 p-3 pt-0 md:p-4 md:pt-0">
                  {groupBucket.users.map((record) => {
                    const draft = userDrafts[record.id];
                    if (!draft) return null;
                    return (
                      <Card key={record.id} className="border-border/70 shadow-none">
                        <details>
                          <summary className="list-none cursor-pointer [&::-webkit-details-marker]:hidden">
                            <CardHeader className="flex flex-row items-start justify-between gap-3">
                              <div className="min-w-0">
                                <CardTitle className="truncate text-base font-semibold">
                                  {record.username}
                                </CardTitle>
                                <div className="truncate text-xs text-muted-foreground">
                                  {record.email || '未绑定邮箱'}
                                </div>
                              </div>
                              <span className="shrink-0 text-xs text-muted-foreground">
                                点击展开/收起
                              </span>
                            </CardHeader>
                          </summary>
                          <CardContent className="space-y-4">
                            <div className="grid gap-4 md:grid-cols-2">
                              <div className="grid gap-2">
                                <Label>昵称</Label>
                                <Input
                                  value={draft.display_name}
                                  onChange={(event) =>
                                    handleUpdateUserDraft(record.id, {
                                      display_name: event.target.value
                                    })
                                  }
                                />
                              </div>
                              <div className="grid gap-2">
                                <Label>头像 URL</Label>
                                <Input
                                  value={draft.avatar_url}
                                  onChange={(event) =>
                                    handleUpdateUserDraft(record.id, {
                                      avatar_url: event.target.value
                                    })
                                  }
                                />
                              </div>
                              <div className="grid gap-2">
                                <Label>权限组</Label>
                                <Select
                                  value={draft.group_id}
                                  onValueChange={(value) =>
                                    handleUpdateUserDraft(record.id, {
                                      group_id: value
                                    })
                                  }
                                >
                                  <SelectTrigger>
                                    <SelectValue placeholder="选择权限组" />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {groupOptions.map((group) => (
                                      <SelectItem
                                        key={group.value}
                                        value={group.value}
                                      >
                                        {group.label}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </div>
                              <div className="grid gap-2">
                                <Label>管理员</Label>
                                <div className="flex items-center justify-between rounded-md border border-input px-3 py-2">
                                  <span className="text-sm text-muted-foreground">
                                    {draft.is_admin ? '是' : '否'}
                                  </span>
                                  <Switch
                                    checked={draft.is_admin}
                                    onCheckedChange={(checked) =>
                                      handleUpdateUserDraft(record.id, {
                                        is_admin: checked
                                      })
                                    }
                                  />
                                </div>
                              </div>
                              <div className="grid gap-2 md:col-span-2">
                                <Label>模型白名单覆盖（逗号分隔）</Label>
                                <Input
                                  value={draft.allowed_models}
                                  placeholder="gpt-5.2-codex, ..."
                                  onChange={(event) =>
                                    handleUpdateUserDraft(record.id, {
                                      allowed_models: event.target.value
                                    })
                                  }
                                />
                                <p className="text-xs text-muted-foreground">
                                  留空表示继承权限组。
                                </p>
                              </div>
                              <div className="grid gap-2 md:col-span-2">
                                <Label>模型总次数覆盖（JSON）</Label>
                                <Textarea
                                  value={draft.model_quotas}
                                  onChange={(event) =>
                                    handleUpdateUserDraft(record.id, {
                                      model_quotas: event.target.value
                                    })
                                  }
                                />
                                <p className="text-xs text-muted-foreground">
                                  例：{`{"gpt-5.2-codex": 30}`}，留空表示继承权限组。
                                </p>
                              </div>
                              <div className="grid gap-2 md:col-span-2">
                                <Label>模型每日次数覆盖（JSON）</Label>
                                <Textarea
                                  value={draft.model_daily_quotas}
                                  onChange={(event) =>
                                    handleUpdateUserDraft(record.id, {
                                      model_daily_quotas: event.target.value
                                    })
                                  }
                                />
                                <p className="text-xs text-muted-foreground">
                                  例：{`{"gpt-5.2-codex": 10}`}，留空表示继承权限组。
                                </p>
                              </div>
                            </div>
                            <div className="flex flex-col gap-2 text-xs text-muted-foreground">
                              <span>总用量：{JSON.stringify(record.usage || {})}</span>
                              <span>
                                每日用量：{JSON.stringify(record.usage_daily || {})}
                              </span>
                            </div>
                            <div className="flex justify-end gap-2">
                              <Button
                                variant="outline"
                                onClick={() => handleDeleteUser(record)}
                              >
                                删除用户
                              </Button>
                              <Button onClick={() => handleSaveUser(record)}>
                                保存
                              </Button>
                            </div>
                          </CardContent>
                        </details>
                      </Card>
                    );
                  })}
                </div>
              </details>
            ))}
          </TabsContent>

          <TabsContent value="groups" className="space-y-4">
            <div className="flex justify-end">
              {isCreatingGroup ? (
                <Button
                  variant="outline"
                  onClick={() => setIsCreatingGroup(false)}
                >
                  取消新建
                </Button>
              ) : (
                <Button onClick={handleStartCreateGroup}>新建权限组</Button>
              )}
            </div>

            {isCreatingGroup ? (
              <Card className="border-border/70 shadow-none">
                <CardHeader className="flex flex-row items-center justify-between gap-3">
                  <CardTitle className="text-base font-semibold">
                    新建权限组
                  </CardTitle>
                  <span className="text-xs text-muted-foreground">
                    填写配置后点击创建
                  </span>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="grid gap-2 md:col-span-2">
                      <Label>名称</Label>
                      <Input
                        value={newGroup.name}
                        onChange={(event) =>
                          setNewGroup((prev) => ({
                            ...prev,
                            name: event.target.value
                          }))
                        }
                      />
                    </div>
                  </div>

                  <ModelRuleEditor
                    draft={newGroup}
                    models={buildModelCatalog(newGroup)}
                    onAllowAllChange={(checked) =>
                      setNewGroup((prev) => ({ ...prev, allow_all_models: checked }))
                    }
                    onSelectAll={handleSelectAllNewGroupModels}
                    onModelToggle={(modelId, enabled) =>
                      handleUpdateNewGroupModel(modelId, { enabled })
                    }
                    onModelQuotaChange={(modelId, quota) =>
                      handleUpdateNewGroupModel(modelId, { quota })
                    }
                    onModelModeChange={(modelId, mode) =>
                      handleUpdateNewGroupModel(modelId, { mode })
                    }
                  />

                  <SettingsPolicyEditor
                    draft={newGroup}
                    onOpenalexAllowChange={(checked) =>
                      setNewGroup((prev) => ({
                        ...prev,
                        openalex_allow_user_adjust: checked
                      }))
                    }
                    onWebsearchAllowChange={(checked) =>
                      setNewGroup((prev) => ({
                        ...prev,
                        websearch_allow_user_adjust: checked
                      }))
                    }
                    onOpenalexNumberPatch={(key, patch) =>
                      handleUpdateNewGroupPolicyNumber('openalex', key, patch)
                    }
                    onWebsearchNumberPatch={(key, patch) =>
                      handleUpdateNewGroupPolicyNumber('websearch', key, patch)
                    }
                    onOpenalexFlagChange={handleUpdateNewGroupPolicyFlag}
                  />

                  <div className="flex justify-end gap-2">
                    <Button
                      variant="outline"
                      onClick={() => setIsCreatingGroup(false)}
                    >
                      取消
                    </Button>
                    <Button onClick={handleCreateGroup}>创建权限组</Button>
                  </div>
                </CardContent>
              </Card>
            ) : null}

            {groups.length === 0 && !loading ? (
              <Alert variant="info">暂无权限组</Alert>
            ) : null}
            {groups.map((record) => {
              const draft = groupDrafts[record.id];
              if (!draft) return null;
              const modelCatalog = buildModelCatalog(draft, record);

              return (
                <Card key={record.id} className="border-border/70 shadow-none">
                  <details>
                    <summary className="list-none cursor-pointer [&::-webkit-details-marker]:hidden">
                      <CardHeader className="flex flex-row items-center justify-between gap-3">
                        <CardTitle className="text-base font-semibold">
                          {record.name}
                        </CardTitle>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          点击展开/收起
                        </span>
                      </CardHeader>
                    </summary>
                  <CardContent className="space-y-4">
                    <div className="grid gap-4 md:grid-cols-2">
                      <div className="grid gap-2 md:col-span-2">
                        <Label>名称</Label>
                        <Input
                          value={draft.name}
                          onChange={(event) =>
                            handleUpdateGroupDraft(record.id, {
                              name: event.target.value
                            })
                          }
                        />
                      </div>
                    </div>

                    <ModelRuleEditor
                      draft={draft}
                      models={modelCatalog}
                      onAllowAllChange={(checked) =>
                        handleUpdateGroupDraft(record.id, {
                          allow_all_models: checked
                        })
                      }
                      onSelectAll={(enabled) =>
                        handleSelectAllGroupModels(record.id, enabled)
                      }
                      onModelToggle={(modelId, enabled) =>
                        handleUpdateGroupModel(record.id, modelId, { enabled })
                      }
                      onModelQuotaChange={(modelId, quota) =>
                        handleUpdateGroupModel(record.id, modelId, { quota })
                      }
                      onModelModeChange={(modelId, mode) =>
                        handleUpdateGroupModel(record.id, modelId, { mode })
                      }
                    />

                    <SettingsPolicyEditor
                      draft={draft}
                      onOpenalexAllowChange={(checked) =>
                        handleUpdateGroupDraft(record.id, {
                          openalex_allow_user_adjust: checked
                        })
                      }
                      onWebsearchAllowChange={(checked) =>
                        handleUpdateGroupDraft(record.id, {
                          websearch_allow_user_adjust: checked
                        })
                      }
                      onOpenalexNumberPatch={(key, patch) =>
                        handleUpdateGroupPolicyNumber(
                          record.id,
                          'openalex',
                          key,
                          patch
                        )
                      }
                      onWebsearchNumberPatch={(key, patch) =>
                        handleUpdateGroupPolicyNumber(
                          record.id,
                          'websearch',
                          key,
                          patch
                        )
                      }
                      onOpenalexFlagChange={(key, value) =>
                        handleUpdateGroupPolicyFlag(record.id, key, value)
                      }
                    />
                    <div className="flex justify-end gap-2">
                      <Button
                        variant="outline"
                        onClick={() => handleCopyGroup(record)}
                      >
                        复制权限组
                      </Button>
                      <Button
                        variant="outline"
                        disabled={record.id === 'admin' || record.id === 'guest'}
                        onClick={() => handleDeleteGroup(record)}
                      >
                        删除权限组
                      </Button>
                      <Button onClick={() => handleSaveGroup(record)}>保存</Button>
                    </div>
                  </CardContent>
                  </details>
                </Card>
              );
            })}
          </TabsContent>

          <TabsContent value="providers" className="space-y-4">
            <div className="flex justify-end">
              {isCreatingProvider ? (
                <Button
                  variant="outline"
                  onClick={() => setIsCreatingProvider(false)}
                >
                  取消新建
                </Button>
              ) : (
                <Button
                  disabled={!providersEncryptionReady}
                  onClick={handleStartCreateProvider}
                >
                  新建 API Key
                </Button>
              )}
            </div>

            {providersError ? <Alert variant="error">{providersError}</Alert> : null}

            {isCreatingProvider ? (
              <Card className="border-border/70 shadow-none">
                <CardHeader className="flex flex-row items-center justify-between gap-3">
                  <CardTitle className="text-base font-semibold">
                    新建 API Key
                  </CardTitle>
                  <span className="text-xs text-muted-foreground">
                    创建后可继续刷新模型列表
                  </span>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="grid gap-2">
                      <Label>名称</Label>
                      <Input
                        value={newProvider.name}
                        onChange={(event) =>
                          setNewProvider((prev) => ({
                            ...prev,
                            name: event.target.value
                          }))
                        }
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label>类型</Label>
                      <Select
                        value={newProvider.type}
                        onValueChange={(value) => {
                          const nextType = toProviderType(value);
                          setNewProvider((prev) => ({
                            ...prev,
                            type: nextType,
                            model_prefix:
                              prev.model_prefix.trim() ||
                              getDefaultProviderPrefix(nextType),
                            base_url:
                              prev.base_url.trim() ||
                              getDefaultProviderBaseUrl(nextType)
                          }));
                        }}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="选择类型" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="openai_compat">
                            OpenAI Compatible
                          </SelectItem>
                          <SelectItem value="qwen_responses">
                            Qwen Responses
                          </SelectItem>
                          <SelectItem value="dashscope">DashScope</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="grid gap-2">
                      <Label>Base URL</Label>
                      <Input
                        value={newProvider.base_url}
                        onChange={(event) =>
                          setNewProvider((prev) => ({
                            ...prev,
                            base_url: event.target.value
                          }))
                        }
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label>模型前缀</Label>
                      <Input
                        value={newProvider.model_prefix}
                        onChange={(event) =>
                          setNewProvider((prev) => ({
                            ...prev,
                            model_prefix: event.target.value
                          }))
                        }
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label>优先级（数字越小越优先）</Label>
                      <Input
                        type="number"
                        value={newProvider.priority}
                        onChange={(event) =>
                          setNewProvider((prev) => ({
                            ...prev,
                            priority: event.target.value
                          }))
                        }
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label>WebSearch 工具模式</Label>
                      <Select
                        value={newProvider.websearch_tool_mode}
                        onValueChange={(value) =>
                          setNewProvider((prev) => ({
                            ...prev,
                            websearch_tool_mode: toWebsearchToolMode(value)
                          }))
                        }
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="选择模式" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="auto">auto</SelectItem>
                          <SelectItem value="on">on</SelectItem>
                          <SelectItem value="off">off</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="grid gap-2 md:col-span-2">
                      <Label>API Key</Label>
                      <Input
                        type="password"
                        value={newProvider.api_key}
                        placeholder="输入 API Key（必填）"
                        onChange={(event) =>
                          setNewProvider((prev) => ({
                            ...prev,
                            api_key: event.target.value
                          }))
                        }
                      />
                    </div>
                    <div className="grid gap-2 md:col-span-2">
                      <Label>启用状态</Label>
                      <div className="flex items-center justify-between rounded-md border border-input px-3 py-2">
                        <span className="text-sm text-muted-foreground">
                          {newProvider.enabled ? '启用' : '停用'}
                        </span>
                        <Switch
                          checked={newProvider.enabled}
                          onCheckedChange={(checked) =>
                            setNewProvider((prev) => ({
                              ...prev,
                              enabled: checked
                            }))
                          }
                        />
                      </div>
                    </div>
                  </div>

                  <details className="rounded-lg border border-border/60 bg-background/40">
                    <summary className="cursor-pointer list-none px-3 py-2 text-sm font-medium text-muted-foreground [&::-webkit-details-marker]:hidden">
                      模型暴露范围（{newProvider.exposed_models.length}）
                    </summary>
                    <div className="space-y-3 p-3 pt-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={newProvider.model_options.length === 0}
                          onClick={() => handleSelectAllNewProviderModels(true)}
                        >
                          全选
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={newProvider.model_options.length === 0}
                          onClick={() => handleSelectAllNewProviderModels(false)}
                        >
                          全不选
                        </Button>
                      </div>
                      {newProvider.model_options.length === 0 ? (
                        <Alert variant="info">
                          暂无可选模型。创建后可在卡片中使用“刷新模型”拉取。
                        </Alert>
                      ) : (
                        <div className="grid gap-2">
                          {newProvider.model_options.map((model) => (
                            <div
                              key={model.id}
                              className="flex items-start gap-3 rounded-lg border border-border/60 p-3"
                            >
                              <Checkbox
                                checked={newProvider.exposed_models.includes(
                                  model.id
                                )}
                                onCheckedChange={(checked) =>
                                  handleToggleNewProviderModel(
                                    model.id,
                                    checked === true
                                  )
                                }
                              />
                              <div className="min-w-0">
                                <div className="truncate text-sm font-medium">
                                  {model.label || model.id}
                                </div>
                                <div className="truncate text-xs text-muted-foreground">
                                  {(newProvider.model_prefix ||
                                    getDefaultProviderPrefix(newProvider.type)) +
                                    ':' +
                                    model.id}
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </details>

                  <div className="flex justify-end gap-2">
                    <Button
                      variant="outline"
                      onClick={() => setIsCreatingProvider(false)}
                    >
                      取消
                    </Button>
                    <Button
                      disabled={!providersEncryptionReady}
                      onClick={handleCreateProvider}
                    >
                      创建 API Key
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ) : null}

            {providers.length === 0 && !loading && !providersError ? (
              <Alert variant="info">暂无 API Keys</Alert>
            ) : null}

            {providers.map((record) => {
              const draft = providerDrafts[record.id];
              if (!draft) return null;
              const canRefreshModels =
                providersEncryptionReady || record.id === 'legacy-openai-env';
              const canSaveProvider =
                providersEncryptionReady || record.id === 'legacy-openai-env';
              const fallbackOptions =
                providerModelSeedsByPrefix.get(
                  String(draft.model_prefix || '').trim().toLowerCase()
                ) || [];
              const modelOptions = dedupeProviderModels([
                ...fallbackOptions,
                ...draft.model_options
              ]);
              const selectedCount = (draft.exposed_models || []).length;
              return (
                <Card key={record.id} className="border-border/70 shadow-none">
                  <details>
                    <summary className="list-none cursor-pointer [&::-webkit-details-marker]:hidden">
                      <CardHeader className="flex flex-row items-center justify-between gap-3">
                        <div className="min-w-0">
                          <CardTitle className="truncate text-base font-semibold">
                            {draft.name || record.name || record.id}
                          </CardTitle>
                          <div className="truncate text-xs text-muted-foreground">
                            {record.id} · {draft.model_prefix}
                          </div>
                        </div>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          点击展开/收起
                        </span>
                      </CardHeader>
                    </summary>
                    <CardContent className="space-y-4">
                      <div className="grid gap-4 md:grid-cols-2">
                        <div className="grid gap-2">
                          <Label>名称</Label>
                          <Input
                            value={draft.name}
                            onChange={(event) =>
                              handleUpdateProviderDraft(record.id, {
                                name: event.target.value
                              })
                            }
                          />
                        </div>
                        <div className="grid gap-2">
                          <Label>类型</Label>
                          <Select
                            value={draft.type}
                            onValueChange={(value) => {
                              const nextType = toProviderType(value);
                              handleUpdateProviderDraft(record.id, {
                                type: nextType,
                                model_prefix:
                                  draft.model_prefix.trim() ||
                                  getDefaultProviderPrefix(nextType),
                                base_url:
                                  draft.base_url.trim() ||
                                  getDefaultProviderBaseUrl(nextType)
                              });
                            }}
                          >
                            <SelectTrigger>
                              <SelectValue placeholder="选择类型" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="openai_compat">
                                OpenAI Compatible
                              </SelectItem>
                              <SelectItem value="qwen_responses">
                                Qwen Responses
                              </SelectItem>
                              <SelectItem value="dashscope">DashScope</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="grid gap-2">
                          <Label>Base URL</Label>
                          <Input
                            value={draft.base_url}
                            onChange={(event) =>
                              handleUpdateProviderDraft(record.id, {
                                base_url: event.target.value
                              })
                            }
                          />
                        </div>
                        <div className="grid gap-2">
                          <Label>模型前缀</Label>
                          <Input
                            value={draft.model_prefix}
                            onChange={(event) =>
                              handleUpdateProviderDraft(record.id, {
                                model_prefix: event.target.value
                              })
                            }
                          />
                        </div>
                        <div className="grid gap-2">
                          <Label>优先级（数字越小越优先）</Label>
                          <Input
                            type="number"
                            value={draft.priority}
                            onChange={(event) =>
                              handleUpdateProviderDraft(record.id, {
                                priority: event.target.value
                              })
                            }
                          />
                        </div>
                        <div className="grid gap-2">
                          <Label>WebSearch 工具模式</Label>
                          <Select
                            value={draft.websearch_tool_mode}
                            onValueChange={(value) =>
                              handleUpdateProviderDraft(record.id, {
                                websearch_tool_mode: toWebsearchToolMode(value)
                              })
                            }
                          >
                            <SelectTrigger>
                              <SelectValue placeholder="选择模式" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="auto">auto</SelectItem>
                              <SelectItem value="on">on</SelectItem>
                              <SelectItem value="off">off</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="grid gap-2 md:col-span-2">
                          <Label>启用状态</Label>
                          <div className="flex items-center justify-between rounded-md border border-input px-3 py-2">
                            <span className="text-sm text-muted-foreground">
                              {draft.enabled ? '启用' : '停用'}
                            </span>
                            <Switch
                              checked={draft.enabled}
                              onCheckedChange={(checked) =>
                                handleUpdateProviderDraft(record.id, {
                                  enabled: checked
                                })
                              }
                            />
                          </div>
                        </div>
                        <div className="grid gap-2 md:col-span-2">
                          <Label>API Key</Label>
                          <div className="rounded-lg border border-border/60 p-3">
                            <div className="text-xs text-muted-foreground">
                              当前：
                              {record.api_key_hint ||
                                (record.has_api_key ? '已设置（已脱敏）' : '未设置')}
                            </div>
                            <Input
                              type="password"
                              className="mt-2"
                              value={draft.api_key}
                              placeholder="留空不修改，输入后保存更新"
                              onChange={(event) =>
                                handleUpdateProviderDraft(record.id, {
                                  api_key: event.target.value,
                                  clear_api_key: false
                                })
                              }
                            />
                            <div className="mt-2 flex justify-end">
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                disabled={!providersEncryptionReady}
                                onClick={() =>
                                  handleUpdateProviderDraft(record.id, {
                                    api_key: '',
                                    clear_api_key: true
                                  })
                                }
                              >
                                清空已存储 Key
                              </Button>
                            </div>
                          </div>
                        </div>
                      </div>

                      <details className="rounded-lg border border-border/60 bg-background/40">
                        <summary className="cursor-pointer list-none px-3 py-2 text-sm font-medium text-muted-foreground [&::-webkit-details-marker]:hidden">
                          模型暴露范围（{selectedCount}）
                        </summary>
                        <div className="space-y-3 p-3 pt-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={!canRefreshModels}
                              onClick={() => handleRefreshProviderModels(record.id)}
                            >
                              刷新模型
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={modelOptions.length === 0}
                              onClick={() =>
                                handleSelectAllProviderModels(record.id, true)
                              }
                            >
                              全选
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={modelOptions.length === 0}
                              onClick={() =>
                                handleSelectAllProviderModels(record.id, false)
                              }
                            >
                              全不选
                            </Button>
                          </div>
                          {modelOptions.length === 0 ? (
                            <Alert variant="info">
                              暂无模型，请点击“刷新模型”从上游接口拉取。
                            </Alert>
                          ) : (
                            <div className="grid gap-2">
                              {modelOptions.map((model) => (
                                <div
                                  key={model.id}
                                  className="flex items-start gap-3 rounded-lg border border-border/60 p-3"
                                >
                                  <Checkbox
                                    checked={draft.exposed_models.includes(
                                      model.id
                                    )}
                                    onCheckedChange={(checked) =>
                                      handleToggleProviderModel(
                                        record.id,
                                        model.id,
                                        checked === true
                                      )
                                    }
                                  />
                                  <div className="min-w-0">
                                    <div className="truncate text-sm font-medium">
                                      {model.label || model.id}
                                    </div>
                                    <div className="truncate text-xs text-muted-foreground">
                                      {model.prefixed_id ||
                                        `${draft.model_prefix}:${model.id}`}
                                    </div>
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </details>

                      <div className="flex justify-end gap-2">
                        <Button
                          variant="outline"
                          disabled={!providersEncryptionReady}
                          onClick={() => handleDeleteProvider(record)}
                        >
                          删除 API Key
                        </Button>
                        <Button
                          disabled={!canSaveProvider}
                          onClick={() => handleSaveProvider(record)}
                        >
                          保存
                        </Button>
                      </div>
                    </CardContent>
                  </details>
                </Card>
              );
            })}
          </TabsContent>

          <TabsContent value="invites" className="space-y-4">
            <Card className="border-border/70 shadow-none">
              <CardHeader>
                <CardTitle className="text-base font-semibold">
                  生成邀请码
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid gap-2">
                  <Label>权限组</Label>
                  <Select value={inviteGroupId} onValueChange={setInviteGroupId}>
                    <SelectTrigger>
                      <SelectValue placeholder="选择权限组" />
                    </SelectTrigger>
                    <SelectContent>
                      {groupOptions.map((group) => (
                        <SelectItem key={group.value} value={group.value}>
                          {group.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Button onClick={handleCreateInvite}>生成邀请码</Button>
              </CardContent>
            </Card>

            {invites.length === 0 && !loading ? (
              <Alert variant="info">暂无邀请码</Alert>
            ) : null}
            {invites.map((invite) => (
              <Card key={invite.code} className="border-border/70 shadow-none">
                <CardHeader>
                  <CardTitle className="text-base font-semibold">
                    {invite.code}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  <div className="text-sm text-muted-foreground">
                    权限组：{invite.group_id}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    状态：{invite.used ? '已使用' : '未使用'}
                  </div>
                  {invite.used_by ? (
                    <div className="text-xs text-muted-foreground">
                      使用者：{invite.used_by}
                    </div>
                  ) : null}
                  <div className="flex justify-end">
                    <Button
                      variant="outline"
                      onClick={() => handleDeleteInvite(invite.code)}
                    >
                      删除
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
