import type { AdapterContext, SiteAdapter } from './types';
import { demoAdapter } from './demo';
import { genericAdapter } from './generic';
import { mokaAdapter } from './moka';
import { beisenAdapter } from './beisen';
import { feishuAdapter } from './feishu';
import { feishuFormilyAdapter } from './feishu-formily';

/** 匹配多个专用适配器时不叠加：选最具体且唯一的一个，否则回退通用模式。 */
const SPECIFIC_ADAPTERS: SiteAdapter[] = [feishuAdapter, feishuFormilyAdapter, beisenAdapter, mokaAdapter, demoAdapter];

export interface AdapterSelection {
  adapter: SiteAdapter;
  fellBack: boolean;
  reason: string | null;
}

export function selectAdapter(context: AdapterContext): AdapterSelection {
  const matched = SPECIFIC_ADAPTERS.filter((adapter) => {
    try {
      return adapter.matches(context);
    } catch {
      return false;
    }
  });
  if (matched.length === 1) return { adapter: matched[0]!, fellBack: false, reason: null };
  if (matched.length > 1) {
    return {
      adapter: genericAdapter,
      fellBack: true,
      reason: `有 ${matched.length} 个适配器同时匹配，已回退到通用模式`,
    };
  }
  return { adapter: genericAdapter, fellBack: false, reason: null };
}
