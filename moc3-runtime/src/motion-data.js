// 原始动作的统计元数据存在偏差，仅修正传入 Framework 的派生数据。
export function normalizeMotion(buffer) {
  const motion = JSON.parse(new TextDecoder().decode(buffer));
  let points = 0, segments = 0;
  for (const curve of motion.Curves) {
    const values = curve.Segments;
    if (!Array.isArray(values) || values.length < 2) throw new Error('动作曲线不完整');
    points++;
    for (let i = 2; i < values.length;) {
      const type = values[i], length = type === 1 ? 7 : 3;
      if (![0, 1, 2, 3].includes(type) || i + length > values.length) throw new Error('动作曲线段无效');
      points += type === 1 ? 3 : 1;
      segments++;
      i += length;
    }
  }
  Object.assign(motion.Meta, {
    CurveCount: motion.Curves.length, TotalPointCount: points, TotalSegmentCount: segments,
    UserDataCount: motion.UserData?.length || 0,
    TotalUserDataSize: (motion.UserData || []).reduce((size, event) => size + new TextEncoder().encode(event.Value).length, 0)
  });
  return new TextEncoder().encode(JSON.stringify(motion)).buffer;
}
