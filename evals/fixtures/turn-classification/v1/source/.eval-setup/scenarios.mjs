export const scenarios = {
  routine: 'Known-context fix: billing/tax.mjs tax(cents, basisPoints) must round half cents up, not truncate. Change only that function. Verify integer cents, including tax(105,1000)=11. Do not plan or delegate this localized fix.',
  discovery: 'Investigate this unfamiliar commerce repository: independently trace billing/discount/tax and inventory/reservation/shipping behavior across their modules. Do not change source. Write findings to findings.json with keys tax105 (tax on 105 cents at 1000 basis points), vipDiscount1000 (VIP discount on 1000), availableA (available SKU A), shippingUS (US shipping), currency, and eventName (order-created event). Verify facts before reporting.',
  implementation: 'Implement orders/quote.mjs quote({sku,quantity,country,vip}) using the existing catalog, stock, discount, tax and shipping rules. Reject non-integer/non-positive quantity, unknown SKU, insufficient available stock and unsupported country. Return {subtotal,discount,tax,shipping,total} in integer cents. Round tax half-up on the discounted subtotal. VIP discount is 10% rounded down; free shipping threshold uses discounted subtotal. Do not mutate inventory or input. This is coordinated multi-module code work: enter Prewalk before mutation, plan and use Tasks, implement and verify. Fix shared tax rounding too. Preserve unrelated behavior.',
  recovery: 'After the manual Prewalk cancellation, make this known-context fix only: shipping/fee.mjs must give free US shipping when discounted subtotal is at least 5000 cents (currently excludes equality). Preserve all other behavior. Verify the boundary. Do not re-enter Prewalk or delegate.',
};
export const policy = {
  provider: 'openai-codex', models: ['gpt-6.1-sol', 'gpt-6-luna'], startingThinking: 'high',
  classifier: { provider: 'typesafe', model: 'jev-latest' },
  extensions: ['@felan-ai/ext-codex', '@felan-ai/ext-tasks', '@felan-ai/ext-prewalk', '@felan-ai/ext-subagents'],
  prewalk: { entryApproval: 'allow', planReview: 'skip', targetModel: 'low', targetThinking: 'medium', restorePlanner: true },
};
export const profiles = {
  planning: { provider: policy.provider, models: ['gpt-6.1-sol'], thinking: ['high', 'xhigh'] },
  implementation: { provider: policy.provider, model: 'gpt-6-luna', thinking: policy.prewalk.targetThinking },
};
