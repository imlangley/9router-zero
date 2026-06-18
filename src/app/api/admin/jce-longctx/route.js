import { NextResponse } from "next/server";
import { createCombo, getComboByName } from "@/lib/db/repos/combosRepo";
import { getSettings, updateSettings } from "@/lib/db/repos/settingsRepo";
import { validateApiKey } from "@/lib/db/repos/apiKeysRepo";

export async function POST(request) {
  const apiKey = request.headers.get("authorization")?.replace("Bearer ", "");
  if (!apiKey || !(await validateApiKey(apiKey))) {
    return NextResponse.json({ error: "Invalid API key" }, { status: 401 });
  }

  try {
    // Create jce-longctx combo if it doesn't exist
    let combo = await getComboByName("jce-longctx");
    if (!combo) {
      combo = await createCombo({
        name: "jce-longctx",
        models: [
          "leaf-longctx-capacity",
          "leaf-qd-fallback",
          "leaf-kr-deep-fallback",
          "leaf-cx-fallback",
        ],
        kind: "chat",
      });
    }

    // Update settings to add capacity auto-switch strategy
    const settings = await getSettings();
    const comboStrategies = { ...(settings.comboStrategies || {}) };
    comboStrategies["jce-longctx"] = {
      fallbackStrategy: "capacity",
      autoSwitch: true,
    };

    await updateSettings({ comboStrategies });

    return NextResponse.json({
      success: true,
      message: "jce-longctx group created with capacity auto-switch",
      combo: combo.name,
    });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
