// Read (or with a second arg 'del', remove) one secureLocalStore key through the app's own module. args: <key with {uid}> [del]
export async function run(page, [key, op]) {
  return await page.evaluate(async ([k, o]) => {
    const m = await import('/src/utils/secureLocalStore.ts');
    const s = m.default;
    const uid = s.getItem('cipherline_user_id');
    const real = k.replace('{uid}', uid);
    const before = s.getItem(real);
    if (o === 'del') s.removeItem(real);
    return { key: real, value: before };
  }, [key, op]);
}
