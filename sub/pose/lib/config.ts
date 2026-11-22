/*! 姿势配置：图源、分级、开关都在这里，设置页可以改。 */

export type PersonaPolicy = 'minor' | 'adult';
export type ViewPreference = 'auto' | 'front' | 'diag' | 'side' | 'back' | 'high' | 'low';

export type PoseConfig = {
  /** 高级参考（private 分级）：默认关，页面上不出现任何入口和内容。 */
  advanced: boolean;
  /** 双人参考（couple 分级）：在高级参考之上再加一层，默认关；关着时双人整类不可见。 */
  couple: boolean;
  /** 本地姿势库根目录（含 thumbs/、img/）；留空 = 插件内置 library/。 */
  libraryRoot: string;
  /** 云端图源前缀；本地没图时 302 过去。留空 = 只用本地。 */
  assetBaseUrl: string;
  /** 重新导入时的源目录；留空 = 用 libraryRoot。 */
  importRoot: string;
  /** 成年年龄线，默认 18，最低 18。 */
  adultThreshold: number;
  /** 人格设定读不到年龄时按什么处理。 */
  unknownPersona: PersonaPolicy;
  /** 手动覆盖：只对读不到年龄的人格生效；读到未满 18 仍强制未成年。 */
  personaPolicy: Record<string, PersonaPolicy>;
  /** 优先给深度图（ControlNet 用），页面缩略图也跟着换。 */
  preferDepth: boolean;
  /** 默认视角：auto = 优先正面。 */
  viewPreference: ViewPreference;
};

export const MIRROR_BASE = 'https://ai-pose-gallery.anhao.app/';

export const DEFAULT_CONFIG: PoseConfig = {
  advanced: false,
  couple: false,
  libraryRoot: '',
  assetBaseUrl: MIRROR_BASE,
  importRoot: '',
  adultThreshold: 18,
  unknownPersona: 'minor',
  personaPolicy: {},
  preferDepth: false,
  viewPreference: 'auto',
};

const VIEWS: ViewPreference[] = ['auto', 'front', 'diag', 'side', 'back', 'high', 'low'];

function normalizeAssetBase(value: unknown): string {
  const raw = String(value ?? '').trim().slice(0, 500);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
    const text = url.toString();
    return text.endsWith('/') ? text : text + '/';
  } catch {
    return '';
  }
}

export function normalizeConfig(raw: any): PoseConfig {
  const threshold = Number(raw?.adultThreshold);
  const adultThreshold = Number.isFinite(threshold)
    ? Math.min(30, Math.max(18, Math.round(threshold)))
    : DEFAULT_CONFIG.adultThreshold;
  const personaPolicy: Record<string, PersonaPolicy> = {};
  if (raw?.personaPolicy && typeof raw.personaPolicy === 'object') {
    for (const [id, value] of Object.entries(raw.personaPolicy)) {
      if (id && (value === 'minor' || value === 'adult')) personaPolicy[id] = value;
    }
  }
  const viewPreference = VIEWS.includes(raw?.viewPreference) ? raw.viewPreference : DEFAULT_CONFIG.viewPreference;
  return {
    advanced: raw?.advanced === true,
    couple: raw?.advanced === true && raw?.couple === true,
    libraryRoot: String(raw?.libraryRoot ?? '').trim().slice(0, 400),
    assetBaseUrl: normalizeAssetBase(raw?.assetBaseUrl === undefined ? DEFAULT_CONFIG.assetBaseUrl : raw.assetBaseUrl),
    importRoot: String(raw?.importRoot ?? '').trim().slice(0, 400),
    adultThreshold,
    unknownPersona: raw?.unknownPersona === 'adult' ? 'adult' : 'minor',
    personaPolicy,
    preferDepth: raw?.preferDepth === true,
    viewPreference,
  };
}

export async function readConfig(ctx: any): Promise<PoseConfig> {
  try {
    return normalizeConfig(await ctx.config.read('config.json'));
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}
