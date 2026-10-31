# scripts/gen-fanqie-fixtures.py
# 用番茄发布技能的 draft_chapter 生成「期望输出」，供 publish.fanqie.test.ts 对拍。
import glob, json, os, re, sys, types

PIPELINE_DIR = "/Users/tutuu/go/陈波宁案/陈波宁传/发布包/tools"
CHAPTER_DIR = "/Users/tutuu/go/陈波宁案/陈波宁传/改稿"
PICK = [1, 3, 5]  # 取 3 章真实稿件；可按需增减
OUT = os.path.join(os.path.dirname(__file__), "..", "src", "test", "fixtures", "fanqie")

sys.modules["openpyxl"] = types.ModuleType("openpyxl")  # pipeline 顶部 import 了它，但 draft_chapter 不需要
sys.path.insert(0, PIPELINE_DIR)
import pipeline  # noqa: E402

SYNTHETIC = """# 《合成》· 第9章 · 合成样章

**【林舟】**

他推开门，雨声涌进来。

---

> 有人在身后说了一句话。

- 第一条线索
* 第二条线索

这是**加粗**的词，这是`代码`。



三个空行之后的段落。

```
围栏里的文字
```

结尾段落。
"""

os.makedirs(OUT, exist_ok=True)
files = {}
for p in glob.glob(CHAPTER_DIR + "/Ch*.md"):
    m = re.match(r"Ch(\d+)-", os.path.basename(p))
    if m:
        files[int(m.group(1))] = p

synthetic_path = os.path.join(OUT, "synthetic-ch09.md")
open(synthetic_path, "w", encoding="utf-8").write(SYNTHETIC)
files[9] = synthetic_path

for no in PICK + [9]:
    title, body = pipeline.draft_chapter(no, files)
    src = files[no]
    name = f"ch{no:02d}"
    if no != 9:
        open(os.path.join(OUT, f"{name}.md"), "w", encoding="utf-8").write(open(src, encoding="utf-8").read())
    else:
        os.replace(synthetic_path, os.path.join(OUT, f"{name}.md"))
    json.dump({"no": no, "title": title, "body": body},
              open(os.path.join(OUT, f"{name}.expected.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print("wrote", name, "title=", title, "body chars=", len(body))
