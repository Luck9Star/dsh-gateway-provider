// 模拟插件完整流程:findPiModel → buildModel → pi-ai convertMessages
// 验证 glm-5.3-flash 是否因 pi-ai 目录未命中而丢失 zai compat
const base = '/Users/yangyitian/Documents/dev/Agents/dsh/dsh-newapi-provider';
const piDist = '/Users/yangyitian/.dsh/profiles/node_modules/@earendil-works/pi-ai/dist';

const { findPiModel } = await import(base + '/lib/thinking.js');
const { buildModel } = await import(base + '/lib/pi-provider.js');
const { DEFAULT_ENDPOINT_PRIORITY } = await import(base + '/lib/protocols.js');
const oc = await import(piDist + '/api/openai-completions.js');

// pi-ai getCompat 不可导出,按源码规则复刻 detectCompat 对 provider='newapi' 的输出
function detectCompatForNewapi(model) {
  const provider = model.provider; // 'newapi'
  const baseUrl = model.baseUrl;   // 网关地址,不含 z.ai / bigmodel.cn
  const isNonStandard = false;     // 'newapi' 不命中任何名单
  return {
    supportsDeveloperRole: !isNonStandard,  // true!
    thinkingFormat: 'openai',
  };
}

const gw = 'https://my-newapi.example.com';
const cases = [
  ['glm-5.2', { id: 'glm-5.2', name: 'GLM-5.2', endpointTypes: ['openai'], reasoning: true }],
  ['glm-5.3-flash', { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', endpointTypes: ['openai'], reasoning: true }],
];

for (const [label, entry] of cases) {
  const m = buildModel(entry, 'newapi', gw, DEFAULT_ENDPOINT_PRIORITY, {}, undefined);
  const piModel = findPiModel(entry.id);
  console.log('=====', label);
  console.log('  findPiModel:', piModel ? `命中 ${piModel.id} @ ${piModel.provider}` : '未命中(目录只有 glm-4.5-air/4.7/5-turbo/5.1/5.2/5v-turbo)');
  console.log('  buildModel 结果: reasoning=' + m.reasoning + ', compat=' + JSON.stringify(m.compat ?? '(无)'));
  // convertMessages 实际发出的第一条消息 (systemPrompt)
  const ctx = { systemPrompt: 'You are helpful.', messages: [{ role: 'user', content: 'hi', timestamp: 0 }] };
  const compat = m.compat ? { ...detectCompatForNewapi(m), ...m.compat } : detectCompatForNewapi(m);
  const params = oc.convertMessages(m, ctx, compat, {});
  console.log('  发往网关的第一条消息:', JSON.stringify(params[0]));
  console.log('');
}
