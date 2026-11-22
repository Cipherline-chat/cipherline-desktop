/* eslint-disable -- visual harness, not shipped */
const quota = { used_bytes: 2.5e6 + 12e3, limit_bytes: 2e9, member_count: 205, tier_label: '101–500 members', storage_plan: 'ladder', saves_bytes: 2.5e6, emoji_bytes: 12e3, emoji_count: 1 };
const get = async (url: string) => ({ data: String(url).endsWith('/channels') ? { channels: [] } : quota });
const axios: any = { get, isAxiosError: () => false, create: () => axios, defaults: { headers: { common: {} } }, interceptors: { request: { use() {} }, response: { use() {} } } };
export default axios;
export const isAxiosError = () => false;
