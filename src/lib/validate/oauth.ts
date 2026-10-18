import { z } from 'zod';

/**
 * provider の値。
 *
 * **enum にしない**。未登録 provider と未設定 provider を同じ 404 `INVALID_PROVIDER` に
 * 落とすため、判定は registry（`getProvider`）に一本化する。ここで enum で弾くと
 * 未登録だけ 400 になり、login の開始（404）と挙動がずれて情報imits泄露につながる。
 */
export const oauthProviderSchema = z.string().min(1, 'provider が指定されていません');

export const oauthStartQuerySchema = z.object({
  /** open redirect 対策のため、生の値は state 保存時に正規化される（state.ts） */
  redirect_to: z.string().optional(),
});

export const oauthCallbackQuerySchema = z.object({
  code: z.string().min(1).optional(),
  state: z.string().min(1).optional(),
  error: z.string().min(1).optional(),
  error_description: z.string().optional(),
});

export const oauthLinkBodySchema = z.object({
  provider: oauthProviderSchema,
});
/**
 * 連携確認画面の完了リクエスト（Phase 4-B）。
 *
 * `provider` は **受け取らない**。claim の token から解決する方が改竄に強く、
 * 遷移や body を変えても別 provider の claim にすり替わらない。
 */
export const socialConfirmBodySchema = z.object({
  action: z.enum(['signup', 'password']),
  /**
   * password アクションのみ。**空文字も許す**。
   * 空文字は「email が空」なので、body の parse で 400 にせず
   * 通常の認証判定（INVALID_CREDENTIALS）に落とす。UI 側の必須表示に任せる。
   */
  identifier: z.string().max(320).optional(),
  password: z.string().max(128).optional(),
});
