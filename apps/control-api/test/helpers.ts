/** อ่าน response body ใน tests โดยไม่ผูกกับ schema ของ route */
// biome-ignore lint/suspicious/noExplicitAny: assertion ในเทสต์เข้าถึง field แบบอิสระ
export async function json(res: Response): Promise<any> {
  return res.json();
}
