import { describe, expect, test } from "bun:test";
import { splitCommandArgs } from "../src/components";

describe("splitCommandArgs", () => {
  test("แยกด้วยเว้นวรรค — flag หลายตัวเป็นหลาย argument", () => {
    expect(
      splitCommandArgs("--model-id=BAAI/bge-m3 --max-batch-tokens=1024 --auto-truncate"),
    ).toEqual(["--model-id=BAAI/bge-m3", "--max-batch-tokens=1024", "--auto-truncate"]);
  });

  test("คำเดียว → argument เดียว (พฤติกรรมเดิมไม่เปลี่ยน)", () => {
    expect(splitCommandArgs("serve")).toEqual(["serve"]);
  });

  test("เว้นวรรคซ้ำ/หัวท้าย/tab ถูกตัดทิ้ง", () => {
    expect(splitCommandArgs("  node \t server.js  ")).toEqual(["node", "server.js"]);
  });

  test("double quote และ single quote ครอบค่าที่มีเว้นวรรค", () => {
    expect(splitCommandArgs(`sh -c "exec redis-server --appendonly yes"`)).toEqual([
      "sh",
      "-c",
      "exec redis-server --appendonly yes",
    ]);
    expect(splitCommandArgs("echo 'a b' c")).toEqual(["echo", "a b", "c"]);
  });

  test("quote ติดกับข้อความ → รวมเป็น argument เดียว", () => {
    expect(splitCommandArgs(`--name="my app" x`)).toEqual(["--name=my app", "x"]);
  });

  test('"" เป็น argument ว่าง', () => {
    expect(splitCommandArgs(`a "" b`)).toEqual(["a", "", "b"]);
  });

  test("backslash escape นอก quote และใน double quote", () => {
    expect(splitCommandArgs("a\\ b c")).toEqual(["a b", "c"]);
    expect(splitCommandArgs(`"say \\"hi\\""`)).toEqual([`say "hi"`]);
    expect(splitCommandArgs("'a\\b'")).toEqual(["a\\b"]);
  });

  test("ไม่ขยายตัวแปร/สัญลักษณ์ shell", () => {
    expect(splitCommandArgs("echo $HOME && ls *")).toEqual(["echo", "$HOME", "&&", "ls", "*"]);
  });

  test("ว่างเปล่า → ไม่มี argument", () => {
    expect(splitCommandArgs("   ")).toEqual([]);
  });

  test("quote ไม่ปิด → throw", () => {
    expect(() => splitCommandArgs(`sh -c "oops`)).toThrow();
    expect(() => splitCommandArgs("it's")).toThrow();
  });
});
