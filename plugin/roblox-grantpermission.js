const PERM_URL = "https://apis.roblox.com/asset-permissions-api/v1/assets/permissions";

module.exports = {
  name: "Roblox Grant Asset Permission",
  desc: "Beri izin 'Use' sebuah asset (misal audio) ke satu Group atau User Roblox, SATU kali percobaan jujur — kalau Roblox menolak, endpoint ini melapor apa adanya, tidak diulang paksa. Isi salah satu dari groupId atau targetUserId.",
  category: "Roblox",
  path: "/api/roblox/grant-permission?apikey=&robloxkey=&assetId=&groupId=",
  async run(req, res) {
    const { apikey, robloxkey, assetId, groupId, targetUserId } = req.query;

    if (!apikey || !global.apikey.includes(apikey)) {
      return res.status(401).json({ status: false, error: "Apikey invalid atau tidak terdaftar" });
    }
    if (!robloxkey) {
      return res.status(400).json({ status: false, error: "Parameter 'robloxkey' wajib diisi" });
    }
    if (!assetId) {
      return res.status(400).json({ status: false, error: "Parameter 'assetId' wajib diisi" });
    }
    if (!groupId && !targetUserId) {
      return res.status(400).json({ status: false, error: "Isi salah satu dari 'groupId' atau 'targetUserId'" });
    }

    const subjectType = groupId ? "Group" : "User";
    const subjectId = String(groupId || targetUserId);

    try {
      const response = await fetch(PERM_URL, {
        method: "PATCH",
        headers: { "x-api-key": robloxkey, "Content-Type": "application/json" },
        body: JSON.stringify({
          subjectType,
          subjectId,
          action: "Use",
          requests: [{ assetId: Number(assetId) }]
        }),
        signal: AbortSignal.timeout(20000)
      });

      const data = await response.json().catch(() => null);

      if (!response.ok) {
        const message = data?.message || `Roblox HTTP ${response.status}`;
        return res.status(response.status === 401 ? 401 : 502).json({ status: false, error: "Roblox menolak permintaan: " + message });
      }

      const errors = Array.isArray(data?.errors) ? data.errors : [];
      if (errors.length) {
        return res.status(200).json({
          status: true,
          result: {
            granted: false,
            subjectType,
            subjectId,
            reason: errors.map((e) => e?.code || JSON.stringify(e)).join(", ")
          }
        });
      }

      const successIds = Array.isArray(data?.successAssetIds) ? data.successAssetIds.map(String) : null;
      const granted = !successIds || successIds.includes(String(assetId));

      return res.status(200).json({
        status: true,
        result: { granted, subjectType, subjectId, assetId }
      });
    } catch (error) {
      console.error("Roblox Grant Permission Error:", error.message);
      return res.status(500).json({
        status: false,
        error: "Gagal memproses grant permission: " + String(error.message || error).slice(0, 300)
      });
    }
  }
};
