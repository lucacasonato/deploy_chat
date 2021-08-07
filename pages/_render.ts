import {
  getStyleTagProperties,
  virtualSheet,
} from "https://esm.sh/twind/sheets";
import { h, setup } from "../deps.ts";
import {
  RenderContext,
  RenderFn,
} from "https://raw.githubusercontent.com/lucacasonato/fresh/3bce2fb8d367666d191f2b9c460e2802bdcbf053/server.ts";

const sheet = virtualSheet();
const initial = sheet.reset();
setup({ sheet });

export function render(ctx: RenderContext, render: RenderFn) {
  const snapshot = ctx.state.get("twindSnapshot") as unknown[] | null;
  sheet.reset(snapshot || initial);
  render();
  const newSnapshot = sheet.reset(initial);
  ctx.state.set("twindSnapshot", newSnapshot);
}

export function postRender(ctx: RenderContext) {
  const snapshot = ctx.state.get("twindSnapshot") as unknown[] | null;
  if (snapshot !== null) {
    sheet.reset(snapshot);
    const { id, textContent } = getStyleTagProperties(sheet);
    ctx.head.push(
      h("style", { id, dangerouslySetInnerHTML: { __html: textContent } }),
    );
    ctx.head.push(
      h("style", {
        dangerouslySetInnerHTML: {
          __html:
            "html,body{height:100%;}\nbody{background-color: rgb(209, 250, 229);display:flex;justify-content: center;}\nbody>div{flex-direction:column;flex:1;display:flex;align-items:center;}",
        },
      }),
    );
  }
  sheet.reset(initial);
}
