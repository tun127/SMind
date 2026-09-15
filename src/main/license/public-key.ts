/**
 * 内嵌的许可**公钥**（Ed25519，SPKI PEM）。
 *
 * 只有公钥能进仓库：私钥一旦进来，任何人都能签发许可码，整个商业化就没了。
 * 私钥由 `npm run license:keygen` 生成，**写在仓库之外**（默认
 * `%USERPROFILE%\SMind-keys\license-private.pem`）——那个文件要离线备份，
 * 丢了就再也签不出新的许可码（已发出的许可仍然有效，因为公钥在这里）。
 *
 * 公钥换了会**让所有已发出的许可码失效**，所以生成之后不要动它。
 */
export const LICENSE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAhmg0i2q0OpcFzsNrOS9dG9uV2GRamdq036aEIUBz69k=
-----END PUBLIC KEY-----`
