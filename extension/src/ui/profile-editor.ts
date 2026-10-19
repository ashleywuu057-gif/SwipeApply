import { profileDataSchema, formatIssues, parseImportText } from '../shared/schemas';
import { rangeIsValid, isPresent, formatEndDate, formatPartialDate } from '../shared/dates';
import type { EndDate, PartialDate, ProfileData, ProfileFile } from '../shared/types';
import { byId, clear, describeError, el, on, send, toast, type StateView } from './common';

/** 履历编辑器：分区编辑、重复经历增删排序、保存前格式检查。 */

type Draft = ProfileData;

let draft: Draft | null = null;
let draftProfileId: string | null = null;
let draftName = '';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function labelled(text: string, control: HTMLElement): HTMLElement {
  const id = `f-${Math.random().toString(36).slice(2, 9)}`;
  control.setAttribute('id', id);
  return el('div', { class: 'form-field' }, [el('label', { for: id, text }), control]);
}

function textInput(value: string | null, onChange: (next: string | null) => void, type = 'text'): HTMLInputElement {
  const input = el('input', { type, value: value ?? '' });
  on(input, 'change', () => onChange(input.value.trim() === '' ? null : input.value));
  return input;
}

function numberInput(value: number | null, onChange: (next: number | null) => void): HTMLInputElement {
  const input = el('input', { type: 'number', value: value === null ? '' : String(value) });
  on(input, 'change', () => {
    const parsed = input.value.trim() === '' ? null : Number(input.value);
    onChange(parsed === null || Number.isNaN(parsed) ? null : parsed);
  });
  return input;
}

/** 结构化日期：年/月/日分开填写，缺失就是缺失，不自动补齐。 */
function dateEditor(label: string, value: PartialDate | null, onChange: (next: PartialDate | null) => void): HTMLElement {
  const year = el('input', { type: 'number', class: 'date-part', placeholder: '年', value: value?.year ?? '' });
  const month = el('input', { type: 'number', class: 'date-part', placeholder: '月', value: value?.month ?? '' });
  const day = el('input', { type: 'number', class: 'date-part', placeholder: '日', value: value?.day ?? '' });

  const emit = () => {
    const y = year.value.trim();
    if (y === '') {
      onChange(null);
      return;
    }
    const next: PartialDate = { year: Number(y) };
    if (month.value.trim() !== '') next.month = Number(month.value);
    if (day.value.trim() !== '') next.day = Number(day.value);
    onChange(next);
  };
  for (const input of [year, month, day]) on(input, 'change', emit);

  return el('div', { class: 'form-field' }, [
    el('label', { text: label }),
    el('div', { class: 'date-row' }, [year, month, day, el('span', { class: 'hint', text: value ? formatPartialDate(value) : '未填写' })]),
  ]);
}

function endDateEditor(label: string, value: EndDate | null, onChange: (next: EndDate | null) => void): HTMLElement {
  const present = isPresent(value);
  const checkbox = el('input', { type: 'checkbox', ...(present ? { checked: true } : {}) });
  const dateHost = el('div', { class: 'end-date-host' });

  const renderDate = () => {
    clear(dateHost);
    if (checkbox.checked) {
      dateHost.append(el('span', { class: 'hint', text: '至今' }));
      return;
    }
    dateHost.append(
      dateEditor('', present ? null : (value as PartialDate | null), (next) => onChange(next)),
    );
  };

  on(checkbox, 'change', () => {
    onChange(checkbox.checked ? { present: true } : null);
    renderDate();
  });
  renderDate();

  return el('div', { class: 'form-field' }, [
    el('label', { text: label }),
    el('div', { class: 'end-date-row' }, [
      el('label', { class: 'inline' }, [checkbox, '至今']),
      dateHost,
      el('span', { class: 'hint', text: formatEndDate(value) }),
    ]),
  ]);
}

interface RepeatedSpec {
  key: 'education' | 'workExperiences' | 'internships' | 'projects' | 'languages' | 'awards' | 'publications' | 'certificates';
  label: string;
  titleOf: (record: Record<string, unknown>) => string;
  blank: () => Record<string, unknown>;
  fields: (record: Record<string, unknown>, update: () => void) => HTMLElement[];
}

function repeatedSection(spec: RepeatedSpec, rerender: () => void): HTMLElement {
  const data = draft!;
  const store = data as unknown as Record<string, Array<Record<string, unknown>> | undefined>;
  const records = store[spec.key] ?? [];
  if (!store[spec.key]) store[spec.key] = records;
  const host = el('section', { class: 'card' });
  host.append(el('h3', { text: `${spec.label}（${records.length} 条）` }));

  records.forEach((record, index) => {
    const box = el('div', { class: 'record' });
    box.append(
      el('div', { class: 'record-head' }, [
        el('div', {}, [
          el('strong', { text: `${index + 1}. ${spec.titleOf(record)}` }),
          (() => {
            const primary = el('input', {
              type: 'radio',
              name: `primary-${spec.key}`,
              ...(record['primary'] === true ? { checked: true } : {}),
            });
            on(primary, 'change', () => {
              if (!primary.checked) return;
              for (const item of records) item['primary'] = item === record;
            });
            return el('label', { class: 'inline' }, [primary, '默认记录']);
          })(),
        ]),
        el('div', { class: 'record-buttons' }, [
          moveButton('上移', index > 0, () => {
            const [item] = records.splice(index, 1);
            records.splice(index - 1, 0, item!);
            rerender();
          }),
          moveButton('下移', index < records.length - 1, () => {
            const [item] = records.splice(index, 1);
            records.splice(index + 1, 0, item!);
            rerender();
          }),
          moveButton('删除', true, () => {
            records.splice(index, 1);
            rerender();
          }),
        ]),
      ]),
    );
    for (const field of spec.fields(record, rerender)) box.append(field);
    host.append(box);
  });

  const add = el('button', { type: 'button', class: 'ghost', text: `新增${spec.label}` });
  on(add, 'click', () => {
    const record = spec.blank();
    if (records.length === 0) record['primary'] = true;
    records.push(record);
    rerender();
  });
  host.append(add);
  return host;
}

function moveButton(text: string, enabled: boolean, handler: () => void): HTMLButtonElement {
  const button = el('button', { type: 'button', class: 'tiny', text, ...(enabled ? {} : { disabled: true }) });
  if (enabled) on(button, 'click', handler);
  return button;
}

function newId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function renderEditor(host: HTMLElement, state: StateView, rerender: () => void): void {
  const data = draft!;
  clear(host);

  const nameInput = el('input', { type: 'text', value: draftName });
  on(nameInput, 'change', () => {
    draftName = nameInput.value;
  });
  host.append(el('section', { class: 'card' }, [el('h3', { text: '履历名称' }), labelled('名称', nameInput)]));

  const personal = el('section', { class: 'card' }, [el('h3', { text: '基础信息' })]);
  personal.append(labelled('姓名', textInput(data.personal.fullName, (v) => (data.personal.fullName = v ?? ''))));
  personal.append(labelled('英文名', textInput(data.personal.englishName, (v) => (data.personal.englishName = v))));
  personal.append(labelled('邮箱', textInput(data.personal.email, (v) => (data.personal.email = v))));
  personal.append(labelled('手机号', textInput(data.personal.phone, (v) => (data.personal.phone = v))));
  const gender = el('select');
  for (const [value, text] of [['', '未填写'], ['male', '男'], ['female', '女'], ['other', '其他/不愿透露']]) {
    gender.append(el('option', { value: value!, text: text! }));
  }
  gender.value = data.personal.gender ?? '';
  on(gender, 'change', () => {
    data.personal.gender = gender.value === '' ? null : gender.value as NonNullable<typeof data.personal.gender>;
  });
  personal.append(labelled('性别', gender));
  personal.append(labelled('工作经验（按网站选项填，如「应届毕业生」「2 年」）', textInput(
    data.personal.workExperience ?? null,
    (v) => (data.personal.workExperience = v),
  )));
  personal.append(labelled('最近公司', textInput(data.personal.recentCompany ?? null, (v) => (data.personal.recentCompany = v))));
  personal.append(dateEditor('出生日期', data.personal.birthDate, (v) => (data.personal.birthDate = v)));
  personal.append(labelled('现居城市', textInput(data.personal.currentCity, (v) => (data.personal.currentCity = v))));
  personal.append(labelled('籍贯', textInput(data.personal.nativePlace ?? null, (v) => (data.personal.nativePlace = v))));
  personal.append(labelled('国籍', textInput(data.personal.nationality ?? null, (v) => (data.personal.nationality = v))));
  personal.append(labelled('微信号', textInput(data.personal.wechat ?? null, (v) => (data.personal.wechat = v))));
  personal.append(labelled('证件号码（敏感，仅精确适配站点使用）', textInput(
    data.personal.identityNumber ?? null,
    (v) => (data.personal.identityNumber = v),
  )));
  personal.append(labelled('紧急联系人（敏感）', textInput(
    data.personal.emergencyContactName ?? null,
    (v) => (data.personal.emergencyContactName = v),
  )));
  personal.append(labelled('紧急联系电话（敏感）', textInput(
    data.personal.emergencyContactPhone ?? null,
    (v) => (data.personal.emergencyContactPhone = v),
  )));
  personal.append(labelled('与紧急联系人关系（敏感）', textInput(
    data.personal.emergencyContactRelation ?? null,
    (v) => (data.personal.emergencyContactRelation = v),
  )));
  personal.append(labelled('个人主页', textInput(data.personal.homepage, (v) => (data.personal.homepage = v))));
  personal.append(labelled('GitHub', textInput(data.personal.github, (v) => (data.personal.github = v))));
  host.append(personal);

  const preferences = el('section', { class: 'card' }, [el('h3', { text: '求职意向' })]);
  preferences.append(
    labelled(
      '意向岗位（逗号分隔）',
      textInput(data.preferences.targetRoles.join('，'), (v) => {
        data.preferences.targetRoles = (v ?? '').split(/[，,]/).map((item) => item.trim()).filter(Boolean);
      }),
    ),
  );
  preferences.append(labelled('默认意向城市（须出现在意向城市列表）', textInput(
    data.preferences.primaryPreferredCity ?? data.preferences.preferredCities[0] ?? null,
    (v) => (data.preferences.primaryPreferredCity = v),
  )));
  preferences.append(labelled('当前薪资', textInput(data.preferences.currentSalary ?? null, (v) => (data.preferences.currentSalary = v))));
  preferences.append(labelled('期望薪资', textInput(data.preferences.expectedSalary ?? null, (v) => (data.preferences.expectedSalary = v))));
  preferences.append(
    labelled(
      '意向城市（逗号分隔）',
      textInput(data.preferences.preferredCities.join('，'), (v) => {
        data.preferences.preferredCities = (v ?? '').split(/[，,]/).map((item) => item.trim()).filter(Boolean);
      }),
    ),
  );
  preferences.append(labelled('到岗说明', textInput(data.preferences.availabilityText, (v) => (data.preferences.availabilityText = v))));
  preferences.append(labelled('可实习月数', numberInput(data.preferences.internshipMonths, (v) => (data.preferences.internshipMonths = v))));
  preferences.append(labelled('每周可实习天数', numberInput(data.preferences.daysPerWeek, (v) => (data.preferences.daysPerWeek = v))));
  preferences.append(labelled('开发语言（按优先级、逗号分隔）', textInput(
    (data.preferences.developmentLanguages ?? []).join('，'),
    (v) => {
      data.preferences.developmentLanguages = (v ?? '').split(/[，,]/).map((item) => item.trim()).filter(Boolean);
    },
  )));

  const relocation = el('select');
  for (const [value, text] of [['', '未填写'], ['true', '接受'], ['false', '不接受']]) {
    relocation.append(el('option', { value: value!, text: text! }));
  }
  relocation.value = data.preferences.acceptsRelocation === null ? '' : String(data.preferences.acceptsRelocation);
  on(relocation, 'change', () => {
    data.preferences.acceptsRelocation = relocation.value === '' ? null : relocation.value === 'true';
  });
  preferences.append(labelled('是否接受异地', relocation));
  host.append(preferences);

  host.append(
    repeatedSection(
      {
        key: 'workExperiences',
        label: '工作经历',
        titleOf: (record) => String(record['company'] ?? '未命名'),
        blank: () => ({
          id: newId('work'), company: '', department: null, title: null, city: null,
          startDate: null, endDate: null, description: null,
        }),
        fields: (record) => [
          labelled('公司', textInput(record['company'] as string, (v) => (record['company'] = v ?? ''))),
          labelled('部门', textInput(record['department'] as string | null, (v) => (record['department'] = v))),
          labelled('职位', textInput(record['title'] as string | null, (v) => (record['title'] = v))),
          labelled('城市', textInput(record['city'] as string | null, (v) => (record['city'] = v))),
          dateEditor('开始时间', record['startDate'] as PartialDate | null, (v) => (record['startDate'] = v)),
          endDateEditor('结束时间', record['endDate'] as EndDate | null, (v) => (record['endDate'] = v)),
          labelled('工作职责', textArea(record['description'] as string | null, (v) => (record['description'] = v))),
        ],
      },
      rerender,
    ),
  );

  host.append(
    repeatedSection(
      {
        key: 'education',
        label: '教育经历',
        titleOf: (record) => String(record['school'] ?? '未命名'),
        blank: () => ({
          id: newId('edu'), school: '', department: null, degreeLevel: 'bachelor', enrollmentStatus: null,
          major: null, startDate: null, endDate: null, gpa: null, gpaScale: null, description: null,
          educationType: null, majorRanking: null, lab: null, researchDirection: null, advisor: null,
          advisorResearchDirection: null, studentNumber: null,
        }),
        fields: (record) => {
          const degree = el('select');
          for (const [value, text] of [['bachelor', '本科'], ['master', '硕士'], ['doctor', '博士'], ['associate', '大专'], ['other', '其他']]) {
            degree.append(el('option', { value: value!, text: text! }));
          }
          degree.value = String(record['degreeLevel']);
          on(degree, 'change', () => (record['degreeLevel'] = degree.value));

          const status = el('select');
          for (const [value, text] of [['', '未填写'], ['enrolled', '在读'], ['graduated', '已毕业']]) {
            status.append(el('option', { value: value!, text: text! }));
          }
          status.value = record['enrollmentStatus'] === null ? '' : String(record['enrollmentStatus']);
          on(status, 'change', () => (record['enrollmentStatus'] = status.value === '' ? null : status.value));

          return [
            labelled('学校', textInput(record['school'] as string, (v) => (record['school'] = v ?? ''))),
            labelled('院系', textInput(record['department'] as string | null, (v) => (record['department'] = v))),
            labelled('学历层级', degree),
            labelled('就读状态', status),
            labelled('专业', textInput(record['major'] as string | null, (v) => (record['major'] = v))),
            dateEditor('入学时间', record['startDate'] as PartialDate | null, (v) => (record['startDate'] = v)),
            dateEditor('毕业时间', record['endDate'] as PartialDate | null, (v) => (record['endDate'] = v)),
            labelled('GPA', textInput(record['gpa'] as string | null, (v) => (record['gpa'] = v))),
            labelled('GPA 满分', textInput(record['gpaScale'] as string | null, (v) => (record['gpaScale'] = v))),
            labelled('学历类型（fullTimeUnified/fullTime/partTime/other）', textInput(
              record['educationType'] as string | null,
              (v) => (record['educationType'] = v),
            )),
            labelled('专业排名', textInput(record['majorRanking'] as string | null, (v) => (record['majorRanking'] = v))),
            labelled('实验室', textInput(record['lab'] as string | null, (v) => (record['lab'] = v))),
            labelled('研究方向', textInput(record['researchDirection'] as string | null, (v) => (record['researchDirection'] = v))),
            labelled('导师', textInput(record['advisor'] as string | null, (v) => (record['advisor'] = v))),
            labelled('导师研究方向', textInput(
              record['advisorResearchDirection'] as string | null,
              (v) => (record['advisorResearchDirection'] = v),
            )),
            labelled('学号', textInput(record['studentNumber'] as string | null, (v) => (record['studentNumber'] = v))),
            labelled('描述', textArea(record['description'] as string | null, (v) => (record['description'] = v))),
          ];
        },
      },
      rerender,
    ),
  );

  host.append(
    repeatedSection(
      {
        key: 'internships',
        label: '实习经历',
        titleOf: (record) => String(record['company'] ?? '未命名'),
        blank: () => ({
          id: newId('intern'), company: '', department: null, title: null, city: null,
          startDate: null, endDate: null, description: null,
        }),
        fields: (record) => [
          labelled('公司', textInput(record['company'] as string, (v) => (record['company'] = v ?? ''))),
          labelled('部门', textInput(record['department'] as string | null, (v) => (record['department'] = v))),
          labelled('职位', textInput(record['title'] as string | null, (v) => (record['title'] = v))),
          labelled('城市', textInput(record['city'] as string | null, (v) => (record['city'] = v))),
          dateEditor('开始时间', record['startDate'] as PartialDate | null, (v) => (record['startDate'] = v)),
          endDateEditor('结束时间', record['endDate'] as EndDate | null, (v) => (record['endDate'] = v)),
          labelled('描述', textArea(record['description'] as string | null, (v) => (record['description'] = v))),
        ],
      },
      rerender,
    ),
  );

  host.append(
    repeatedSection(
      {
        key: 'projects',
        label: '项目经历',
        titleOf: (record) => String(record['name'] ?? '未命名'),
        blank: () => ({ id: newId('project'), name: '', role: null, startDate: null, endDate: null, url: null, description: null }),
        fields: (record) => [
          labelled('项目名称', textInput(record['name'] as string, (v) => (record['name'] = v ?? ''))),
          labelled('角色', textInput(record['role'] as string | null, (v) => (record['role'] = v))),
          dateEditor('开始时间', record['startDate'] as PartialDate | null, (v) => (record['startDate'] = v)),
          endDateEditor('结束时间', record['endDate'] as EndDate | null, (v) => (record['endDate'] = v)),
          labelled('链接', textInput(record['url'] as string | null, (v) => (record['url'] = v))),
          labelled('描述', textArea(record['description'] as string | null, (v) => (record['description'] = v))),
        ],
      },
      rerender,
    ),
  );

  host.append(
    repeatedSection(
      {
        key: 'languages',
        label: '语言能力',
        titleOf: (record) => String(record['language'] ?? '未命名'),
        blank: () => ({ id: newId('lang'), language: '', certificate: null, score: null, examDate: null }),
        fields: (record) => [
          labelled('语种', textInput(record['language'] as string, (v) => (record['language'] = v ?? ''))),
          labelled('证书', textInput(record['certificate'] as string | null, (v) => (record['certificate'] = v))),
          labelled('分数', textInput(record['score'] as string | null, (v) => (record['score'] = v))),
          dateEditor('考试时间', record['examDate'] as PartialDate | null, (v) => (record['examDate'] = v)),
          labelled('掌握程度', textInput(record['proficiency'] as string | null, (v) => (record['proficiency'] = v))),
          labelled('听说', textInput(record['listeningSpeaking'] as string | null, (v) => (record['listeningSpeaking'] = v))),
          labelled('读写', textInput(record['readingWriting'] as string | null, (v) => (record['readingWriting'] = v))),
        ],
      },
      rerender,
    ),
  );

  host.append(
    repeatedSection(
      {
        key: 'awards',
        label: '获奖经历',
        titleOf: (record) => String(record['name'] ?? '未命名'),
        blank: () => ({ id: newId('award'), name: '', date: null, issuer: null, description: null }),
        fields: (record) => [
          labelled('奖项名称', textInput(record['name'] as string, (v) => (record['name'] = v ?? ''))),
          dateEditor('获奖时间', record['date'] as PartialDate | null, (v) => (record['date'] = v)),
          labelled('颁发单位', textInput(record['issuer'] as string | null, (v) => (record['issuer'] = v))),
          labelled('说明', textArea(record['description'] as string | null, (v) => (record['description'] = v))),
        ],
      },
      rerender,
    ),
  );

  host.append(
    repeatedSection(
      {
        key: 'publications',
        label: '论文/专著',
        titleOf: (record) => String(record['name'] ?? '未命名'),
        blank: () => ({ id: newId('publication'), name: '', publishedAt: null, description: null }),
        fields: (record) => [
          labelled('名称', textInput(record['name'] as string, (v) => (record['name'] = v ?? ''))),
          dateEditor('发布时间', record['publishedAt'] as PartialDate | null, (v) => (record['publishedAt'] = v)),
          labelled('成果描述', textArea(record['description'] as string | null, (v) => (record['description'] = v))),
        ],
      },
      rerender,
    ),
  );

  host.append(
    repeatedSection(
      {
        key: 'certificates',
        label: '证书',
        titleOf: (record) => String(record['name'] ?? '未命名'),
        blank: () => ({ id: newId('certificate'), name: '', obtainedAt: null, description: null }),
        fields: (record) => [
          labelled('证书名称', textInput(record['name'] as string, (v) => (record['name'] = v ?? ''))),
          dateEditor('获得时间', record['obtainedAt'] as PartialDate | null, (v) => (record['obtainedAt'] = v)),
          labelled('证书描述', textArea(record['description'] as string | null, (v) => (record['description'] = v))),
        ],
      },
      rerender,
    ),
  );

  const intro = el('section', { class: 'card' }, [el('h3', { text: '自我介绍' })]);
  intro.append(labelled('内容', textArea(data.selfIntroduction, (v) => (data.selfIntroduction = v))));
  host.append(intro);

  const errors = el('div', { class: 'errors', id: 'editor-errors' });
  host.append(errors);

  const save = el('button', { type: 'button', class: 'primary', id: 'btn-save-profile', text: '保存为新版本' });
  on(save, 'click', () => void saveDraft(state, errors));
  host.append(save);
}

function textArea(value: string | null, onChange: (next: string | null) => void): HTMLTextAreaElement {
  const area = el('textarea', { rows: 4 });
  area.value = value ?? '';
  on(area, 'change', () => onChange(area.value.trim() === '' ? null : area.value));
  return area;
}

async function saveDraft(state: StateView, errorHost: HTMLElement): Promise<void> {
  clear(errorHost);
  if (!draft || !draftProfileId) return;

  const problems: string[] = [];
  for (const record of draft.education) {
    if (!rangeIsValid(record.startDate, record.endDate)) {
      problems.push(`教育经历「${record.school}」的毕业时间早于入学时间`);
    }
  }
  for (const record of draft.workExperiences ?? []) {
    if (!rangeIsValid(record.startDate, record.endDate)) problems.push(`工作经历「${record.company}」的结束时间早于开始时间`);
  }
  for (const record of draft.internships) {
    if (!rangeIsValid(record.startDate, record.endDate)) problems.push(`实习经历「${record.company}」的结束时间早于开始时间`);
  }
  for (const record of draft.projects) {
    if (!rangeIsValid(record.startDate, record.endDate)) problems.push(`项目「${record.name}」的结束时间早于开始时间`);
  }

  const parsed = profileDataSchema.safeParse(draft);
  if (!parsed.success) {
    for (const issue of formatIssues(parsed.error)) problems.push(`${issue.path}：${issue.message}`);
  }

  if (problems.length > 0) {
    for (const problem of problems) errorHost.append(el('p', { class: 'error', text: problem }));
    toast('保存前检查未通过，已保留原版本', 'error');
    return;
  }

  try {
    await send('SAVE_PROFILE', {
      profileId: draftProfileId,
      name: draftName,
      data: draft,
      expectedRevision: state.revision,
    });
    toast('已保存为新版本，历史版本保留', 'success');
    location.hash = 'profiles';
    window.dispatchEvent(new CustomEvent('applykit-reload'));
  } catch (error) {
    toast(describeError(error), 'error');
  }
}

export function renderProfiles(state: StateView, reload: () => void): void {
  const host = byId('view-profiles');
  clear(host);

  host.append(
    el('div', { class: 'panel-head' }, [
      el('h2', { text: '履历管理' }),
      el('p', { class: 'muted', text: '编辑保存会生成新的版本快照，历史版本与投递记录的引用不会被改写。' }),
    ]),
  );

  const importCard = el('section', { class: 'card' }, [
    el('h3', { text: '导入履历文件' }),
    el('p', { class: 'muted', text: '只接受 kind 为 applykit-profile 的文件。投递记录 CSV 与完整备份有各自的入口。' }),
  ]);
  const fileInput = el('input', { type: 'file', accept: '.json,application/json', id: 'profile-file' });
  const importButton = el('button', { type: 'button', class: 'primary', text: '校验并导入' });
  const preview = el('div', { class: 'preview' });

  on(importButton, 'click', () => {
    const file = fileInput.files?.[0];
    if (!file) {
      toast('请先选择文件', 'error');
      return;
    }
    void importProfileFile(file, state, preview, reload);
  });
  importCard.append(fileInput, importButton, preview);
  host.append(importCard);

  const list = el('section', { class: 'card' }, [el('h3', { text: `已保存的版本（${state.profiles.length}）` })]);
  if (state.profiles.length === 0) {
    list.append(el('p', { class: 'empty', text: '还没有履历。请先导入 fixtures/profile.demo.json。' }));
  }
  for (const profile of state.profiles) {
    const active = profile.profileVersionId === state.activeProfileVersionId;
    const row = el('div', { class: `record${active ? ' record-active' : ''}` }, [
      el('div', {}, [
        el('strong', { text: profile.name }),
        el('span', { class: 'field-meta', text: ` ${profile.profileVersionId}` }),
      ]),
      el('p', {
        class: 'muted',
        text: `来源：${sourceLabel(profile)} · 教育 ${profile.data.education.length} 条 · 工作 ${profile.data.workExperiences?.length ?? 0} 条 · 项目 ${profile.data.projects.length} 条 · 奖项 ${profile.data.awards?.length ?? 0} 条`,
      }),
    ]);
    const buttons = el('div', { class: 'record-buttons' });
    if (!active) {
      const use = el('button', { type: 'button', class: 'tiny', text: '设为当前版本' });
      on(use, 'click', () => {
        void send('SET_ACTIVE_PROFILE', { profileVersionId: profile.profileVersionId, expectedRevision: state.revision })
          .then(() => {
            toast('已切换当前版本', 'success');
            reload();
          })
          .catch((error: unknown) => toast(describeError(error), 'error'));
      });
      buttons.append(use);
    } else {
      buttons.append(el('span', { class: 'badge badge-filled', text: '当前版本' }));
    }
    const edit = el('button', { type: 'button', class: 'tiny', text: '编辑' });
    on(edit, 'click', () => {
      draft = clone(profile.data);
      draftProfileId = profile.profileId;
      draftName = profile.name;
      renderEditor(byId('view-editor'), state, () => renderEditor(byId('view-editor'), state, () => undefined));
      location.hash = 'editor';
    });
    buttons.append(edit);

    const exportButton = el('button', { type: 'button', class: 'tiny', text: '导出' });
    on(exportButton, 'click', () => {
      const blob = JSON.stringify(profile, null, 2);
      const link = el('a', {
        href: URL.createObjectURL(new Blob([blob], { type: 'application/json;charset=utf-8' })),
        download: `${profile.profileVersionId}.json`,
      });
      document.body.append(link);
      link.click();
      link.remove();
    });
    buttons.append(exportButton);

    row.append(buttons);
    list.append(row);
  }
  host.append(list);
}

function sourceLabel(profile: ProfileFile): string {
  const type = { demo: '演示', manual: '手动创建', import: '导入' }[profile.source.type];
  const status = profile.source.status === 'fictional' ? '虚构资料' : '已由用户审阅';
  return `${type} · ${status}`;
}

async function importProfileFile(file: File, state: StateView, preview: HTMLElement, reload: () => void): Promise<void> {
  clear(preview);
  const raw = await file.text();
  const parsed = parseImportText(raw, 'applykit-profile');
  if (!parsed.ok) {
    preview.append(el('p', { class: 'error', text: '文件未通过校验，已有数据没有改变：' }));
    for (const issue of parsed.errors) preview.append(el('p', { class: 'error', text: `${issue.path}：${issue.message}` }));
    return;
  }
  const profile = parsed.value as ProfileFile;
  preview.append(
    el('div', { class: 'card' }, [
      el('h4', { text: '导入预览' }),
      el('p', { text: `名称：${profile.name}` }),
      el('p', { text: `版本：${profile.profileVersionId} · 来源：${sourceLabel(profile)}` }),
      el('p', { text: `姓名：${profile.data.personal.fullName} · 教育 ${profile.data.education.length} 条 · 工作 ${profile.data.workExperiences?.length ?? 0} 条 · 实习 ${profile.data.internships.length} 条 · 项目 ${profile.data.projects.length} 条 · 奖项 ${profile.data.awards?.length ?? 0} 条` }),
      profile.source.status === 'fictional'
        ? el('p', { class: 'warn', text: '这是虚构演示资料，只能在本地演示页面（127.0.0.1 / localhost）填写。' })
        : null,
    ]),
  );

  const confirm = el('button', { type: 'button', class: 'primary', id: 'btn-confirm-import', text: '确认导入' });
  on(confirm, 'click', () => {
    void send('IMPORT_PROFILE', { file: profile, expectedRevision: state.revision, onConflict: 'reject' })
      .then(() => {
        toast('履历已导入并设为当前版本', 'success');
        reload();
      })
      .catch((error: unknown) => {
        const message = describeError(error);
        if (message.includes('内容不同')) {
          const saveAs = el('button', { type: 'button', class: 'ghost', text: '另存为新版本' });
          on(saveAs, 'click', () => {
            void send('IMPORT_PROFILE', { file: profile, expectedRevision: state.revision, onConflict: 'save-as-new' })
              .then(() => {
                toast('已另存为新版本', 'success');
                reload();
              })
              .catch((inner: unknown) => toast(describeError(inner), 'error'));
          });
          preview.append(el('p', { class: 'error', text: message }), saveAs);
        } else {
          toast(message, 'error');
        }
      });
  });
  preview.append(confirm);
}

export function renderEditorView(state: StateView): void {
  const host = byId('view-editor');
  if (!draft) {
    clear(host);
    host.append(el('p', { class: 'empty', text: '请先在「履历」页选择一个版本并点击编辑。' }));
    return;
  }
  renderEditor(host, state, () => renderEditorView(state));
}
