// スタッフ定義（1ヶ所に集約）
// 将来のスタッフ追加・色変更はここだけ変えれば済む。
// key  : 内部キー（予約フロントマターの staff フィールドに保存される値）
// name : 表示名
// color: 管理画面バッジ色（くすみ系の上品な色）

export const STAFF = [
  { key: 'nakamura',   name: '中村', color: '#7B9E8A' }, // くすみグリーン
  { key: 'matsuyoshi', name: '松吉', color: '#8A7BA0' }, // くすみパープル
];

// 空キー（指名なし）の表示定義
export const NO_STAFF = { key: '', name: '指名なし', color: '#B8A090' };

// 有効キーのセット（バリデーション用）
export const VALID_STAFF_KEYS = new Set(['', ...STAFF.map(s => s.key)]);

// キーから定義を引く（''なら NO_STAFF、未知キーなら NO_STAFF にフォールバック）
export function staffByKey(key) {
  if (!key) return NO_STAFF;
  return STAFF.find(s => s.key === key) || NO_STAFF;
}
