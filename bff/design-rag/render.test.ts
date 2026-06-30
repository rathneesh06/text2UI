// bff/design-rag/render.test.ts — offline. Pure helpers; no browser.
import assert from "node:assert";
import { transpileTsx, rewriteAppImports, buildRenderHtml, renderExemplarToPng, type RenderOpts } from "./render";
import type { GeneratedFile } from "../../shared/types";

// ---- transpileTsx: JSX lowered, ReactJSX runtime ---------------------------
{
  const js = transpileTsx('const A = () => <div className="x">hi</div>;\nexport default A;');
  assert.ok(js.includes("react/jsx-runtime"), "ReactJSX emit imports jsx-runtime");
  assert.ok(!js.includes("<div"), "JSX lowered to function calls");
}

// ---- rewriteAppImports: relative -> injected specifiers --------------------
{
  const js = rewriteAppImports('import { query } from "./data";\nimport { selectFeature } from "./selection";');
  assert.ok(js.includes('"app-data"') && js.includes('"app-selection"'));
  assert.ok(!js.includes('"./data"') && !js.includes('"./selection"'));
}

// ---- buildRenderHtml: import map, app modules, css, mount ------------------
{
  const html = buildRenderHtml({ appJs: "export default ()=>null;", css: "BODY{color:red}", esmBase: "https://esm.test" });
  assert.ok(html.includes('type="importmap"'), "import map present");
  assert.ok(html.includes("https://esm.test/react@"), "esm base honored");
  assert.ok(html.includes('"app-app"') && html.includes('"app-data"') && html.includes('"app-selection"'), "app modules mapped");
  assert.ok(html.includes('id="root"'), "mount point");
  assert.ok(html.includes("BODY{color:red}"), "css inlined");
  assert.ok(html.includes('type="module"'), "mount script");
}

// ---- renderExemplarToPng: wires transpile -> css -> html -> render ---------
{
  let capturedHtml = "";
  const fakeCompile = (files: GeneratedFile[]) => {
    assert.equal(files[0].path, "App.tsx", "compiles the exemplar code");
    return Promise.resolve("BODYCSS{}");
  };
  const fakeRender = (html: string, _o?: RenderOpts) => { capturedHtml = html; return Promise.resolve(Buffer.from("PNGDATA")); };
  const png = await renderExemplarToPng(
    'import { query } from "./data";\nconst A = () => <div>x</div>;\nexport default A;',
    { compileCss: fakeCompile, renderToPng: fakeRender },
  );
  assert.equal(png.toString(), "PNGDATA", "returns the render buffer");
  assert.ok(capturedHtml.includes("BODYCSS{}"), "compiled css inlined into the page");
  assert.ok(capturedHtml.includes('type="importmap"'), "page is the render html");
}

console.log("ok design-rag/render");
