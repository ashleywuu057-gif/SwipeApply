import { describe, expect, it } from 'vitest';
import { areaSearchChoices, areaValuesEqual } from '../../src/content/controls/area-picker';

describe('北森地区粒度投影', () => {
  it('区县级籍贯先尝试区县，站点不支持时退到所属城市', () => {
    expect(areaSearchChoices('江苏省苏州市吴中区')).toEqual(['吴中区', '苏州市']);
    expect(areaValuesEqual('苏州市', '江苏省苏州市吴中区')).toBe(true);
  });

  it('现居城市继续兼容有无“市”后缀', () => {
    expect(areaSearchChoices('杭州')).toEqual(['杭州']);
    expect(areaValuesEqual('杭州市', '杭州')).toBe(true);
  });

  it('不会把详细籍贯直接退化成整个省份', () => {
    expect(areaSearchChoices('江苏省苏州市吴中区')).not.toContain('江苏省');
    expect(areaValuesEqual('江苏省', '江苏省苏州市吴中区')).toBe(false);
    expect(areaValuesEqual('江苏省苏州市姑苏区', '江苏省苏州市吴中区')).toBe(false);
  });
});
