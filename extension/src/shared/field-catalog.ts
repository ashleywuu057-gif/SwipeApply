import type {
  DegreeLevel, EndDate, FieldRef, KnownSection, PartialDate, ProfileData, SectionKind,
} from './types';
import { normalizeLabel } from './normalize';

/**
 * 可填字段白名单。网页与缓存规则只能引用这里的 field 名称，
 * 不允许携带任意 JS 路径或表达式。
 */

export type ValueKind = 'text' | 'longText' | 'date' | 'endDate' | 'boolean' | 'number' | 'stringList' | 'enum';

export interface CatalogField {
  field: string;
  /** 用户可读名称，例如「专业」。 */
  label: string;
  valueKind: ValueKind;
  aliases: string[];
  /** true 时不参与自动填写，只能由用户逐项确认。 */
  requiresConfirmation?: boolean;
  /** 枚举字段的等价词表：履历值 -> 网页可接受写法。 */
  enumEquivalents?: Record<string, string[]>;
  /** 敏感字段只有同时得到站点适配器明确绑定时才允许自动填写。 */
  sensitiveAutofill?: boolean;
  /** 网页要求完整日期时使用的用户授权默认值；已保存的月/日始终优先。 */
  dateDefault?: { month: number; day: number };
}

export interface CatalogSection {
  section: KnownSection;
  label: string;
  repeated: boolean;
  fields: CatalogField[];
}

const DEGREE_EQUIVALENTS: Record<DegreeLevel, string[]> = {
  bachelor: ['本科', '学士', '大学本科', 'Bachelor'],
  master: ['硕士', '研究生', '硕士研究生', 'Master'],
  doctor: ['博士', '博士研究生', 'Doctor', 'PhD'],
  associate: ['大专', '专科', 'Associate'],
  other: ['其他', 'Other'],
};

const ENROLLMENT_EQUIVALENTS: Record<string, string[]> = {
  enrolled: ['在读', '在校', '就读中'],
  graduated: ['已毕业', '毕业', '已获得学历'],
};

const GENDER_EQUIVALENTS: Record<string, string[]> = {
  male: ['男', 'Male'],
  female: ['女', 'Female'],
  other: ['其他', '不愿透露', 'Other'],
};

const NATIONALITY_EQUIVALENTS: Record<string, string[]> = {
  中华人民共和国: ['中华人民共和国', '中国', '中国大陆', 'China'],
};

const EDUCATION_TYPE_EQUIVALENTS: Record<string, string[]> = {
  fullTimeUnified: ['全日制统招', '统招全日制', '全国普通高等院校全日制', '普通高等院校全日制', '全日制', '统招'],
  fullTime: ['全日制'],
  partTime: ['非全日制', '在职'],
  other: ['其他'],
};

const ENGLISH_LEVEL_EQUIVALENTS: Record<string, string[]> = {
  'CET-4': ['CET-4', 'CET4', '大学英语四级', '英语四级', '四级'],
  'CET-6': ['CET-6', 'CET6', '大学英语六级', '英语六级', '六级'],
};

export const CATALOG: CatalogSection[] = [
  {
    section: 'personal',
    label: '基础信息',
    repeated: false,
    fields: [
      { field: 'fullName', label: '姓名', valueKind: 'text', aliases: ['姓名', '中文姓名', '真实姓名', '本人姓名', 'full name', 'name', '申请人姓名'] },
      { field: 'englishName', label: '英文名', valueKind: 'text', aliases: ['英文名', '英文姓名', 'english name'] },
      { field: 'email', label: '邮箱', valueKind: 'text', aliases: ['邮箱', '电子邮箱', '电子邮件', '常用邮箱', 'email', 'e-mail'] },
      { field: 'phone', label: '手机号', valueKind: 'text', aliases: ['手机', '手机号', '手机号码', '移动电话', '联系电话', '联系方式', 'mobile', 'phone'] },
      { field: 'gender', label: '性别', valueKind: 'enum', aliases: ['性别', 'gender'], enumEquivalents: GENDER_EQUIVALENTS },
      { field: 'workExperience', label: '工作经验', valueKind: 'text', aliases: ['工作经验', '工作年限', '工作经验年限'] },
      {
        field: 'highestDegree',
        label: '最高学历',
        valueKind: 'enum',
        aliases: ['最高学历', '最高学位', '最高教育程度'],
        enumEquivalents: DEGREE_EQUIVALENTS,
      },
      {
        field: 'highestEducationType',
        label: '最高学历学习形式',
        valueKind: 'enum',
        aliases: ['学习形式', '最高学历学习形式'],
        enumEquivalents: EDUCATION_TYPE_EQUIVALENTS,
      },
      {
        field: 'highestEducationEndDate',
        label: '最高学历毕业时间',
        valueKind: 'date',
        aliases: ['毕业时间', '最高学历毕业时间'],
        dateDefault: { month: 6, day: 30 },
      },
      { field: 'birthDate', label: '出生日期', valueKind: 'date', aliases: ['出生日期', '出生日期年龄', '出生日期 (年龄)', '生日', 'birth date', 'date of birth'] },
      { field: 'age', label: '年龄', valueKind: 'number', aliases: ['年龄', '周岁', 'age'] },
      { field: 'currentCity', label: '现居城市', valueKind: 'text', aliases: ['现居城市', '现居地', '现居住地', '当前城市', '所在城市', '所在地', '常住城市', 'current city'] },
      { field: 'nativePlace', label: '籍贯', valueKind: 'text', aliases: ['籍贯', '生源地', '祖籍', 'native place', 'hometown'] },
      {
        field: 'englishLevel',
        label: '英语等级',
        valueKind: 'enum',
        aliases: ['英语等级', '英语考试等级'],
        enumEquivalents: ENGLISH_LEVEL_EQUIVALENTS,
      },
      { field: 'englishScore', label: '英语等级成绩', valueKind: 'text', aliases: ['英语等级成绩', '英语成绩'] },
      { field: 'recentCompany', label: '最近公司', valueKind: 'text', aliases: ['最近公司', '最近任职公司', '最近工作单位'] },
      { field: 'homepage', label: '个人主页', valueKind: 'text', aliases: ['个人主页', '主页', '作品集', 'homepage', 'portfolio', '个人网站'] },
      { field: 'github', label: 'GitHub', valueKind: 'text', aliases: ['github', 'github 主页', '代码仓库'] },
      { field: 'nationality', label: '国籍', valueKind: 'enum', aliases: ['国籍', '国籍/地区', '国家/地区', 'nationality'], enumEquivalents: NATIONALITY_EQUIVALENTS },
      { field: 'wechat', label: '微信号', valueKind: 'text', aliases: ['微信', '微信号', 'wechat', 'wechat id'] },
      {
        field: 'identityNumber', label: '证件号码', valueKind: 'text',
        aliases: ['证件号码', '身份证号码', '身份证号'], sensitiveAutofill: true,
      },
      {
        field: 'emergencyContactName', label: '紧急联系人', valueKind: 'text',
        aliases: ['紧急联系人', '紧急联系人姓名'], sensitiveAutofill: true,
      },
      {
        field: 'emergencyContactPhone', label: '紧急联系电话', valueKind: 'text',
        aliases: ['紧急联系电话', '紧急联系人电话', '紧急联系人手机号'], sensitiveAutofill: true,
      },
      {
        field: 'emergencyContactRelation', label: '紧急联系人关系', valueKind: 'text',
        aliases: ['与紧急联系人关系', '紧急联系人关系'], sensitiveAutofill: true,
      },
      { field: 'noWorkExperience', label: '没有工作经历', valueKind: 'boolean', aliases: ['没有工作经历', '无工作经历'] },
    ],
  },
  {
    section: 'preferences',
    label: '求职意向',
    repeated: false,
    fields: [
      { field: 'targetRoles', label: '意向岗位', valueKind: 'stringList', aliases: ['意向岗位', '期望岗位', '求职意向', '目标岗位', '应聘岗位方向'] },
      { field: 'preferredCities', label: '意向城市列表', valueKind: 'stringList', aliases: ['意向城市列表', '多选意向城市'] },
      { field: 'primaryPreferredCity', label: '默认意向城市', valueKind: 'text', aliases: ['意向城市', '期望城市', '期望工作城市', '期望工作地点', '意向工作城市', '意向工作地点'] },
      { field: 'currentSalary', label: '当前薪资', valueKind: 'text', aliases: ['当前薪资', '现薪', '目前薪资'] },
      { field: 'expectedSalary', label: '期望薪资', valueKind: 'text', aliases: ['期望薪资', '期望月薪', '预期薪资'] },
      { field: 'availabilityText', label: '到岗说明', valueKind: 'text', aliases: ['到岗时间', '可到岗时间', '入职时间', '到岗说明', 'availability'] },
      { field: 'internshipMonths', label: '可实习月数', valueKind: 'number', aliases: ['可实习月数', '实习时长', '可实习时长', '实习月数'] },
      { field: 'daysPerWeek', label: '每周可实习天数', valueKind: 'number', aliases: ['每周可实习天数', '每周天数', '每周出勤天数', '一周可实习几天'] },
      { field: 'acceptsRelocation', label: '接受异地', valueKind: 'boolean', aliases: ['接受异地', '是否接受异地', '接受外派', '是否服从调剂地点', '是否接受工作城市调剂'] },
      { field: 'secondaryPreferredCity1', label: '其他意向城市 1', valueKind: 'text', aliases: ['其他意向城市1', '第二意向城市'] },
      { field: 'secondaryPreferredCity2', label: '其他意向城市 2', valueKind: 'text', aliases: ['其他意向城市2', '第三意向城市'] },
      { field: 'primaryDevelopmentLanguage', label: '主要开发语言', valueKind: 'text', aliases: ['擅长的开发语言1', '主要开发语言', '第一开发语言'] },
      { field: 'secondaryDevelopmentLanguage', label: '其他开发语言', valueKind: 'text', aliases: ['擅长的其他开发语言2', '其他开发语言', '第二开发语言'] },
    ],
  },
  {
    section: 'education',
    label: '教育经历',
    repeated: true,
    fields: [
      { field: 'school', label: '学校', valueKind: 'text', aliases: ['学校', '毕业院校', '就读院校', '学校名称', '院校', 'school', 'university'] },
      { field: 'department', label: '院系', valueKind: 'text', aliases: ['院系', '学院', '学院名称', '所在院系', 'department'] },
      { field: 'degreeLevel', label: '学历层级', valueKind: 'enum', aliases: ['学历', '学历层次', '最高学历', '培养层次', 'degree'], enumEquivalents: DEGREE_EQUIVALENTS },
      { field: 'enrollmentStatus', label: '就读状态', valueKind: 'enum', aliases: ['就读状态', '在读状态', '学籍状态'], enumEquivalents: ENROLLMENT_EQUIVALENTS },
      { field: 'isHighestDegree', label: '是否为最高学历', valueKind: 'boolean', aliases: ['是否为最高学历', '是否最高学历', '最高学历经历'] },
      { field: 'major', label: '专业', valueKind: 'text', aliases: ['专业', '所学专业', '专业名称', 'major'] },
      {
        field: 'startDate', label: '入学时间', valueKind: 'date',
        aliases: ['入学时间', '入学日期', '开始时间', '起始时间', '教育开始时间'],
        dateDefault: { month: 9, day: 1 },
      },
      {
        field: 'endDate', label: '毕业时间', valueKind: 'date',
        aliases: ['毕业时间', '预计毕业时间', '毕业日期', '结束时间', '教育结束时间'],
        dateDefault: { month: 6, day: 30 },
      },
      { field: 'gpa', label: 'GPA', valueKind: 'text', aliases: ['gpa', '成绩(gpa)', '绩点', '平均绩点', '成绩'] },
      { field: 'gpaScale', label: 'GPA 满分', valueKind: 'text', aliases: ['gpa 满分', '绩点满分', '满分制'] },
      { field: 'description', label: '教育描述', valueKind: 'longText', aliases: ['教育描述', '在校经历', '主修课程'] },
      { field: 'educationType', label: '学历类型', valueKind: 'enum', aliases: ['学历类型', '培养方式', '学习形式'], enumEquivalents: EDUCATION_TYPE_EQUIVALENTS },
      { field: 'majorRanking', label: '专业排名', valueKind: 'text', aliases: ['专业排名', '专业成绩排名', '成绩排名', '排名'] },
      { field: 'lab', label: '实验室', valueKind: 'text', aliases: ['实验室', '所属实验室'] },
      { field: 'researchDirection', label: '研究方向', valueKind: 'text', aliases: ['研究方向', '本人研究方向', '课题研究'] },
      { field: 'advisor', label: '导师', valueKind: 'text', aliases: ['导师', '指导教师'] },
      { field: 'advisorResearchDirection', label: '导师研究方向', valueKind: 'text', aliases: ['导师研究方向'] },
      { field: 'studentNumber', label: '学号', valueKind: 'text', aliases: ['学号', '学生编号', 'student number', 'student id'] },
    ],
  },
  {
    section: 'workExperiences',
    label: '工作经历',
    repeated: true,
    fields: [
      { field: 'company', label: '工作单位', valueKind: 'text', aliases: ['单位', '公司名称', '工作单位', '公司', 'company', '就职公司'] },
      { field: 'department', label: '所在部门', valueKind: 'text', aliases: ['部门', '所在部门', '工作部门'] },
      { field: 'title', label: '职位', valueKind: 'text', aliases: ['职位', '岗位名称', '职位名称', 'title', 'position'] },
      { field: 'city', label: '工作城市', valueKind: 'text', aliases: ['工作城市', '工作地点'] },
      { field: 'startDate', label: '工作开始时间', valueKind: 'date', aliases: ['工作开始时间', '开始时间', '起始时间', '入职时间'] },
      { field: 'endDate', label: '工作结束时间', valueKind: 'endDate', aliases: ['工作结束时间', '结束时间', '离职时间', '至今'] },
      { field: 'description', label: '工作职责', valueKind: 'longText', aliases: ['工作职责', '工作内容', '主要职责', '工作描述'] },
    ],
  },
  {
    section: 'internships',
    label: '实习经历',
    repeated: true,
    fields: [
      { field: 'company', label: '实习单位', valueKind: 'text', aliases: ['单位', '单位名称', '公司名称', '实习公司', '实习单位', '公司', 'company', '就职公司'] },
      { field: 'department', label: '所在部门', valueKind: 'text', aliases: ['部门', '所在部门', '实习部门'] },
      { field: 'title', label: '实习岗位', valueKind: 'text', aliases: ['职位', '实习岗位', '岗位名称', '职位名称', '实习职位', 'title', 'position'] },
      { field: 'city', label: '实习城市', valueKind: 'text', aliases: ['实习城市', '工作城市', '实习地点'] },
      { field: 'startDate', label: '实习开始时间', valueKind: 'date', aliases: ['实习开始时间', '开始时间', '起始时间', '入职时间'] },
      { field: 'endDate', label: '实习结束时间', valueKind: 'endDate', aliases: ['实习结束时间', '结束时间', '离职时间', '至今'] },
      { field: 'description', label: '实习描述', valueKind: 'longText', aliases: ['实习描述', '工作内容', '实习内容', '主要职责', '工作职责', '工作描述'] },
    ],
  },
  {
    section: 'projects',
    label: '项目经历',
    repeated: true,
    fields: [
      { field: 'name', label: '项目名称', valueKind: 'text', aliases: ['项目名称', '项目名', '项目', 'project name'] },
      { field: 'role', label: '项目角色', valueKind: 'text', aliases: ['项目职责', '担任角色', '项目角色', '担任职务', '职务', '职责', '项目中职责', 'role'] },
      { field: 'startDate', label: '项目开始时间', valueKind: 'date', aliases: ['项目开始时间', '开始时间', '起始时间'] },
      { field: 'endDate', label: '项目结束时间', valueKind: 'endDate', aliases: ['项目结束时间', '结束时间', '至今'] },
      { field: 'url', label: '项目链接', valueKind: 'text', aliases: ['项目链接', '项目地址', '演示地址', 'project url'] },
      { field: 'description', label: '项目描述', valueKind: 'longText', aliases: ['项目描述', '项目介绍', '项目内容', '项目成果'] },
    ],
  },
  {
    section: 'languages',
    label: '语言能力',
    repeated: true,
    fields: [
      { field: 'language', label: '语种', valueKind: 'text', aliases: ['语种', '语言', '外语语种', '语言类型', '语言名称'] },
      { field: 'certificate', label: '证书', valueKind: 'text', aliases: ['证书', '语言证书', '等级证书'] },
      { field: 'score', label: '分数', valueKind: 'text', aliases: ['分数', '成绩', '考试分数'] },
      { field: 'examDate', label: '考试时间', valueKind: 'date', aliases: ['考试时间', '考试日期'] },
      { field: 'proficiency', label: '掌握程度', valueKind: 'text', aliases: ['掌握程度', '语言熟练度', '熟练程度'] },
      { field: 'listeningSpeaking', label: '听说', valueKind: 'text', aliases: ['听说', '听说能力'] },
      { field: 'readingWriting', label: '读写', valueKind: 'text', aliases: ['读写', '读写能力'] },
    ],
  },
  {
    section: 'awards',
    label: '获奖经历',
    repeated: true,
    fields: [
      { field: 'name', label: '奖项名称', valueKind: 'text', aliases: ['奖项名称', '获奖名称', '荣誉名称', '奖项', '获奖项'] },
      { field: 'date', label: '获奖时间', valueKind: 'date', aliases: ['获奖时间', '获奖日期', '奖项日期'] },
      { field: 'issuer', label: '颁发单位', valueKind: 'text', aliases: ['颁发单位', '颁奖机构', '授予单位'] },
      { field: 'description', label: '奖项说明', valueKind: 'longText', aliases: ['奖项说明', '获奖说明', '获奖描述'] },
    ],
  },
  {
    section: 'publications',
    label: '论文/专著',
    repeated: true,
    fields: [
      { field: 'name', label: '名称', valueKind: 'text', aliases: ['名称', '论文名称', '专著名称', '论文题目', '成果名称'] },
      { field: 'publishedAt', label: '发布时间', valueKind: 'date', aliases: ['发布时间', '发表时间', '发表日期', '出版时间'] },
      { field: 'description', label: '成果描述', valueKind: 'longText', aliases: ['成果描述', '论文描述', '论文摘要', '成果说明'] },
    ],
  },
  {
    section: 'certificates',
    label: '证书',
    repeated: true,
    fields: [
      { field: 'name', label: '证书名称', valueKind: 'text', aliases: ['证书名称', '资质名称', '资格证书'] },
      { field: 'obtainedAt', label: '获得时间', valueKind: 'date', aliases: ['获得时间', '获取时间', '证书日期'] },
      { field: 'description', label: '证书描述', valueKind: 'longText', aliases: ['证书描述', '证书说明', '资质描述'] },
    ],
  },
  {
    section: 'selfIntroduction',
    label: '自我介绍',
    repeated: false,
    fields: [
      { field: 'text', label: '自我介绍', valueKind: 'longText', aliases: ['自我介绍', '个人简介', '个人评价', '自我评价', '个人陈述', '自我描述', '个人描述'] },
    ],
  },
];

const SECTION_INDEX = new Map(CATALOG.map((section) => [section.section, section]));

export function getSection(section: SectionKind): CatalogSection | null {
  if (section === 'unknown') return null;
  return SECTION_INDEX.get(section) ?? null;
}

export function getCatalogField(section: SectionKind, field: string): CatalogField | null {
  const found = getSection(section);
  if (!found) return null;
  return found.fields.find((item) => item.field === field) ?? null;
}

export function isRepeatedSection(section: SectionKind): boolean {
  return getSection(section)?.repeated ?? false;
}

/** FieldRef 合法性：section 存在、field 在白名单内、重复分区必须给 recordId。 */
export function validateFieldRef(ref: FieldRef): { ok: true } | { ok: false; message: string } {
  const section = getSection(ref.section);
  if (!section) return { ok: false, message: `未知分区 ${ref.section}` };
  const field = section.fields.find((item) => item.field === ref.field);
  if (!field) return { ok: false, message: `分区 ${section.label} 没有字段 ${ref.field}` };
  if (section.repeated && !ref.recordId) return { ok: false, message: `${section.label} 必须指定具体记录` };
  if (!section.repeated && ref.recordId) return { ok: false, message: `${section.label} 不接受 recordId` };
  return { ok: true };
}

export type CatalogValue =
  | { kind: 'text'; value: string }
  | { kind: 'longText'; value: string }
  | { kind: 'date'; value: PartialDate }
  | { kind: 'endDate'; value: EndDate }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'number'; value: number }
  | { kind: 'stringList'; value: string[] }
  | { kind: 'enum'; value: string; equivalents: string[] }
  | { kind: 'missing' };

type AnyRecord = Record<string, unknown>;

/** 最高学历完全由已保存的教育记录确定，不补写或猜测履历中没有的事实。 */
function highestDegreeOf(data: ProfileData): DegreeLevel | null {
  const rank: Record<DegreeLevel, number> = { other: 0, associate: 1, bachelor: 2, master: 3, doctor: 4 };
  let highest: DegreeLevel | null = null;
  for (const record of data.education) {
    if (highest === null || rank[record.degreeLevel] > rank[highest]) highest = record.degreeLevel;
  }
  return highest;
}

/** 传音等北森表单会把最高学历详情投影到个人信息区。 */
function highestEducationOf(data: ProfileData): ProfileData['education'][number] | null {
  const highestDegree = highestDegreeOf(data);
  if (!highestDegree) return null;
  const candidates = data.education.filter((record) => record.degreeLevel === highestDegree);
  return candidates.find((record) => record.primary) ?? candidates[0] ?? null;
}

/** 英语等级与成绩只从已保存的英语语言记录读取。 */
function englishLanguageOf(data: ProfileData): ProfileData['languages'][number] | null {
  const records = data.languages.filter((record) => /^(?:英语|english)$/i.test(record.language.trim()));
  return records.find((record) => record.primary) ?? records[0] ?? null;
}

/** “在校生”直接来自已审阅教育记录的在读状态，不根据年龄或日期猜测。 */
function workExperienceOf(data: ProfileData): string | null {
  if (data.personal.workExperience) return data.personal.workExperience;
  return data.education.some((record) => record.enrollmentStatus === 'enrolled') ? '在校生' : null;
}

/** 最近公司优先取显式值，否则取用户标记的默认/最近一段工作或实习。 */
function recentCompanyOf(data: ProfileData): string | null {
  if (data.personal.recentCompany) return data.personal.recentCompany;
  const records = [...(data.workExperiences ?? []), ...data.internships];
  const selected = records.find((record) => record.primary) ?? records.at(-1);
  return selected?.company ?? null;
}

/** 年龄只在出生日期精确到日时计算，避免用不完整日期猜测。 */
function ageOf(data: ProfileData): number | null {
  const birth = data.personal.birthDate;
  if (!birth || birth.month === undefined || birth.day === undefined) return null;
  const now = new Date();
  let age = now.getFullYear() - birth.year;
  if (now.getMonth() + 1 < birth.month ||
      (now.getMonth() + 1 === birth.month && now.getDate() < birth.day)) age -= 1;
  return age >= 0 && age <= 120 ? age : null;
}

function readRepeatedRecord(data: ProfileData, section: KnownSection, recordId: string): AnyRecord | null {
  const list = (data as unknown as Record<string, unknown>)[section];
  if (!Array.isArray(list)) return null;
  return (list as AnyRecord[]).find((record) => record['id'] === recordId) ?? null;
}

/** 按白名单读取值。返回 missing 时调用方报告 SOURCE_MISSING，不得编造。 */
export function readFieldValue(data: ProfileData, ref: FieldRef): CatalogValue {
  const catalogField = getCatalogField(ref.section, ref.field);
  if (!catalogField) return { kind: 'missing' };

  let raw: unknown;
  if (ref.section === 'selfIntroduction') {
    raw = data.selfIntroduction;
  } else if (ref.section === 'personal') {
    const highestEducation = highestEducationOf(data);
    const english = englishLanguageOf(data);
    raw = ref.field === 'highestDegree'
      ? highestDegreeOf(data)
      : ref.field === 'highestEducationType'
        ? highestEducation?.educationType
        : ref.field === 'highestEducationEndDate'
          ? highestEducation?.endDate
          : ref.field === 'englishLevel'
            ? english?.certificate
            : ref.field === 'englishScore'
              ? english?.score
      : ref.field === 'workExperience'
        ? workExperienceOf(data)
        : ref.field === 'recentCompany'
          ? recentCompanyOf(data)
          : ref.field === 'age'
            ? ageOf(data)
            : ref.field === 'noWorkExperience'
              ? (data.workExperiences ?? []).length === 0
          : (data.personal as unknown as AnyRecord)[ref.field];
  } else if (ref.section === 'preferences') {
    const primaryCity = data.preferences.primaryPreferredCity ?? data.preferences.preferredCities[0];
    const otherCities = data.preferences.preferredCities.filter((city) => city !== primaryCity);
    if (ref.field === 'primaryPreferredCity') raw = primaryCity;
    else if (ref.field === 'secondaryPreferredCity1') raw = otherCities[0];
    else if (ref.field === 'secondaryPreferredCity2') raw = otherCities[1];
    else if (ref.field === 'primaryDevelopmentLanguage') raw = data.preferences.developmentLanguages?.[0];
    else if (ref.field === 'secondaryDevelopmentLanguage') raw = data.preferences.developmentLanguages?.[1];
    else raw = (data.preferences as unknown as AnyRecord)[ref.field];
  } else {
    if (!ref.recordId) return { kind: 'missing' };
    const record = readRepeatedRecord(data, ref.section, ref.recordId);
    if (!record) return { kind: 'missing' };
    raw = ref.section === 'education' && ref.field === 'isHighestDegree'
      ? record['degreeLevel'] === highestDegreeOf(data)
      : record[ref.field];
  }

  if (raw === null || raw === undefined) return { kind: 'missing' };

  switch (catalogField.valueKind) {
    case 'text':
    case 'longText': {
      if (typeof raw !== 'string' || raw.trim().length === 0) return { kind: 'missing' };
      return { kind: catalogField.valueKind, value: raw };
    }
    case 'number': {
      if (typeof raw !== 'number' || Number.isNaN(raw)) return { kind: 'missing' };
      return { kind: 'number', value: raw };
    }
    case 'boolean': {
      if (typeof raw !== 'boolean') return { kind: 'missing' };
      return { kind: 'boolean', value: raw };
    }
    case 'stringList': {
      if (!Array.isArray(raw) || raw.length === 0) return { kind: 'missing' };
      return { kind: 'stringList', value: raw.filter((item): item is string => typeof item === 'string') };
    }
    case 'date': {
      if (typeof raw !== 'object' || raw === null || !('year' in raw)) return { kind: 'missing' };
      return { kind: 'date', value: raw as PartialDate };
    }
    case 'endDate': {
      if (typeof raw !== 'object' || raw === null) return { kind: 'missing' };
      return { kind: 'endDate', value: raw as EndDate };
    }
    case 'enum': {
      if (typeof raw !== 'string') return { kind: 'missing' };
      const equivalents = catalogField.enumEquivalents?.[raw] ?? [];
      return { kind: 'enum', value: raw, equivalents };
    }
  }
}

export interface AliasEntry {
  section: KnownSection;
  field: string;
  alias: string;
  normalizedAlias: string;
}

/** 别名索引：归一化后的网页标签 -> 候选字段。 */
export const ALIAS_INDEX: Map<string, AliasEntry[]> = (() => {
  const index = new Map<string, AliasEntry[]>();
  for (const section of CATALOG) {
    for (const field of section.fields) {
      for (const alias of field.aliases) {
        const key = normalizeLabel(alias).toLowerCase();
        const entry: AliasEntry = { section: section.section, field: field.field, alias, normalizedAlias: key };
        const bucket = index.get(key);
        if (bucket) bucket.push(entry);
        else index.set(key, [entry]);
      }
    }
  }
  return index;
})();

/** 用户可读的源字段名称，例如「硕士教育 / 软件工程 / 专业」。 */
export function describeFieldRef(data: ProfileData, ref: FieldRef): string {
  // jobprep：来自你上次手动补填并记住的内容（见 background/remembered.ts）
  if (ref.field === 'remembered') return '你上次手动补填并记住的内容';
  const section = getSection(ref.section);
  const field = getCatalogField(ref.section, ref.field);
  if (!section || !field) return `${ref.section}.${ref.field}`;
  if (!section.repeated || !ref.recordId) return `${section.label} / ${field.label}`;
  const record = readRepeatedRecord(data, ref.section, ref.recordId);
  const title = record
    ? String(record['school'] ?? record['company'] ?? record['name'] ?? record['language'] ?? ref.recordId)
    : ref.recordId;
  return `${section.label} / ${title} / ${field.label}`;
}
