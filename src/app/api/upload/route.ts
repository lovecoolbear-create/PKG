import { NextRequest, NextResponse } from "next/server";
import { writeFile, mkdir } from "fs/promises";
import path from "path";
import { nanoid } from "nanoid";

export async function POST(request: NextRequest) {
  // 请求体不是 multipart/form-data 时 request.formData() 会抛异常。
  // 这是客户端错误，应当 400；混进下面的 catch 会伪装成 500「服务器故障」。
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json(
      { error: "请求格式错误：需以 multipart/form-data 提交文件" },
      { status: 400 }
    );
  }
  try {
    const file = formData.get("file") as File | null;
    const category = (formData.get("category") as string) || "design";
    const productType = (formData.get("productType") as string) || "color_print_box";

    if (!file) {
      return NextResponse.json({ error: "未选择文件" }, { status: 400 });
    }

    const allowedTypes = [
      "application/pdf",
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/gif",
    ];
    if (!allowedTypes.includes(file.type)) {
      return NextResponse.json(
        { error: "不支持的文件格式，请上传 PDF 或图片" },
        { status: 400 }
      );
    }

    const maxSize = 10 * 1024 * 1024;
    if (file.size > maxSize) {
      return NextResponse.json(
        { error: "文件大小不能超过 10MB" },
        { status: 400 }
      );
    }

    const uploadDir = path.join(process.cwd(), "public", "uploads");
    await mkdir(uploadDir, { recursive: true });

    const ext = file.name.split(".").pop() || "bin";
    const filename = `${nanoid(12)}.${ext}`;
    const filepath = path.join(uploadDir, filename);

    const bytes = await file.arrayBuffer();
    await writeFile(filepath, Buffer.from(bytes));

    const feedback = generateUploadFeedback(file, category, productType);

    return NextResponse.json({
      file: {
        id: nanoid(8),
        name: file.name,
        type: file.type,
        size: file.size,
        category,
        url: `/uploads/${filename}`,
      },
      feedback,
    });
  } catch (error) {
    console.error("Upload error:", error);
    return NextResponse.json({ error: "上传失败" }, { status: 500 });
  }
}

function generateUploadFeedback(
  file: File,
  category: string,
  productType: string
): string {
  const isFlat = productType === "flat_print";
  if (category === "design") {
    if (file.type === "application/pdf") {
      return isFlat
        ? "已收到设计稿件（PDF），系统将参考尺寸与工艺进行成本估算"
        : "已收到设计图纸（PDF），系统将参考盒型结构进行成本估算";
    }
    return isFlat
      ? "已收到设计图片，建议同时提供带尺寸的成品样图以提高精度"
      : "已收到设计图片，建议同时提供带尺寸的展开图以提高精度";
  }
  return "已收到产品照片，有助于确认材质与工艺效果";
}
