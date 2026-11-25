import { cleanText, HttpError } from './util.mjs';

export const DEFAULT_TEMPLATE_ID = 'exec-brief';
export const TEMPLATE_LIMITS = { name: 40, rules: 2000 };
export const BASE_HEADINGS = { decision: '决定', action: '行动项', pending: '待确认' };

export const DEPTH_OPTIONS = {
  brief: {
    id: 'brief',
    name: '极简速览',
    rules: '篇幅控制：极简高管速览。全文只保留最核心的 3 至 6 条关键定论、核心数字与紧迫待办，每条尽量精炼为一句话，彻底省略寒暄铺垫与往复讨论过程。',
  },
  standard: {
    id: 'standard',
    name: '标准提炼',
    rules: '篇幅控制：标准内参提炼。清晰列出核心定论、分工期限、关键业务数字及待决风险，兼顾一分钟速读与执行落地。',
  },
  detailed: {
    id: 'detailed',
    name: '完整详录',
    rules: '篇幅控制：完整复盘详录。按实际议题完整保留各方核心论据、边界条件、全部数字细节与待跟进事项，便于事后逐条核查。',
  },
};

export const SCENARIO_PROFILES = {
  meeting: {
    id: 'meeting',
    name: '高管会议',
    subtitle: '聚焦拍板定论、责任人与期限、报价预算；议题久议不决时主动提醒',
    defaultTemplateId: 'exec-brief',
  },
  training: {
    id: 'training',
    name: '培训讲座',
    subtitle: '提炼核心方法论框架、标杆案例数据与可落地的业务启发，过滤口水话',
    defaultTemplateId: 'training-notes',
  },
  chat: {
    id: 'chat',
    name: '日常交谈',
    subtitle: '适合茶叙、拜访与日常持续记录，自动滤除寒暄闲聊，捕捉高价值情报与承诺',
    defaultTemplateId: 'chat-intel',
  },
};

export const BUILTIN_TEMPLATES = [
  {
    id: 'exec-brief', name: '高管拍板简报', scenario: 'meeting', description: '聚焦核心定论、责任期限、关键数字与未决风险',
    rules: '面向企业负责人整理高纯度有效信息。按「核心拍板定论」「责任分工与期限」「关键报价与财务指标」「悬而未决与风险提醒」组织（若某类无内容则省略该节）。只写真实说出的结论、人名、时间与数字，过滤寒暄套话。',
    headings: { decision: '核心拍板定论', action: '责任分工与期限', pending: '悬而未决与风险' },
  },
  {
    id: 'formal-minutes', name: '正式对外纪要', scenario: 'meeting', description: '措辞稳重规范，适合发给客户、合作方或跨部门留档',
    rules: '整理一份措辞得体、条理清晰的正式会议纪要。按「达成共识」「双方后续推进事项」「待进一步确认事项」分段，准确记录各方承诺的时间节点、商务条件与交付物，去除口语化表达。',
    headings: { decision: '达成共识', action: '后续推进事项', pending: '待确认事项' },
  },
  {
    id: 'training-notes', name: '培训与课程精华', scenario: 'training', description: '提炼核心框架、实战案例数据与本公司可落地的行动启发',
    rules: '从培训或分享录音中提炼高价值干货。按「核心方法论与框架」「关键标杆案例与数据」「可借鉴落地的业务动作」组织，过滤讲师寒暄、暖场与重复举例，保留具体指标和执行步骤。',
    headings: { decision: '核心方法论与金句', action: '可落地动作建议', pending: '延伸思考问题' },
  },
  {
    id: 'chat-intel', name: '茶叙与交谈情报', scenario: 'chat', description: '从非正式长谈中去芜存菁，提取商业信号、人脉线索与口头约定',
    rules: '这是一段非正式交谈、拜访或日常持续录音。请彻底过滤生活寒暄、客套话与无关闲聊，专门提炼有长期留存价值的有效信息：按「高价值商业情报与动态」「对方态度偏好与关键诉求」「口头约定与后续跟进线索」整理。',
    headings: { decision: '高价值情报与判断', action: '后续跟进线索', pending: '待核实信息' },
  },
  {
    id: 'general', name: '智能总结', scenario: 'meeting', description: '根据录音内容自动组织',
    rules: '按这段录音的内容组织总结。先交代主要信息，再补充有用的细节。按实际主题分段，保留必要的上下文和明确提到的不确定性。去除口头重复。',
    headings: BASE_HEADINGS,
  },
  {
    id: 'project', name: '要点与跟进', scenario: 'meeting', description: '集中整理结论和后续事项',
    rules: '优先记录已经明确的结论、承诺和下一步。按实际主题分段，录音中有明确的负责人、时间或交付物就写出。对仍在讨论的内容写清不确定之处。',
    headings: { decision: '项目决定', action: '交付行动项', pending: '风险与阻塞' },
  },
  {
    id: 'client', name: '访谈与交流', scenario: 'chat', description: '梳理观点、例子和上下文',
    rules: '按实际讨论的主题整理有价值的观点和例子。转述说话者的判断时保留其条件和语气。只有原文明确说出人物身份时才归属观点。',
    headings: { decision: '双方共识', action: '跟进事项', pending: '待确认需求' },
  },
].map((t) => ({ ...t, revision: 2, builtin: true }));

export function findTemplate(settings, id = settings.defaultTemplateId || DEFAULT_TEMPLATE_ID) {
  return BUILTIN_TEMPLATES.find((t) => t.id === id) || (settings.minutesTemplates || []).find((t) => t.id === id) || BUILTIN_TEMPLATES[0];
}

export function templateSnapshot({ id, name, rules, headings, revision, scenario }) {
  return { id, name, rules, headings: headings || BASE_HEADINGS, revision, ...(scenario ? { scenario } : {}) };
}

export function validateTemplate(body) {
  const check = (v, limit, label, multiline = false) => {
    const s = typeof v === 'string' ? cleanText(v, limit + 1, { multiline }) : '';
    if (!s || s.length > limit) throw new HttpError(400, `${label}需要填写，最多 ${limit} 字`);
    return s;
  };
  const scenario = body.scenario && Object.hasOwn(SCENARIO_PROFILES, body.scenario) ? body.scenario : undefined;
  return {
    name: check(body.name, TEMPLATE_LIMITS.name, '模板名称'),
    rules: check(body.rules, TEMPLATE_LIMITS.rules, '生成规则', true),
    ...(scenario ? { scenario } : {}),
  };
}

export function validateInstruction(value) {
  const text = typeof value === 'string' ? cleanText(value, TEMPLATE_LIMITS.rules + 1, { multiline: true }) : '';
  if (!text || text.length > TEMPLATE_LIMITS.rules) throw new HttpError(400, '请填写总结要求，最多 2000 字');
  return text;
}
