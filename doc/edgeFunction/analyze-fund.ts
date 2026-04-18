// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

console.info("server started");

const AIHUBMIX_API_KEY = Deno.env.get("AIHUBMIX_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ✅ 清洗模型输出
function cleanModelOutput(text: string) {
    if (!text) return "";

    return text
        .replace(/<think>[\s\S]*?<\/think>/gi, "")
        .replace(/```json/gi, "")
        .replace(/```/g, "")
        .trim();
}

// ✅ 提取 JSON
function extractJSON(text: string) {
    if (!text) return null;

    let match = text.match(/\[[\s\S]*\]/);

    if (!match) {
        match = text.match(/\{[\s\S]*\}/);
    }

    if (!match) return null;

    try {
        return JSON.parse(match[0]);
    } catch {
        return null;
    }
}

Deno.serve(async (req: Request) => {
    if (req.method === "OPTIONS") {
        return new Response("ok", { headers: corsHeaders });
    }

    try {
        // ✅ 1. 获取 Authorization header
        const authHeader = req.headers.get("Authorization");

        if (!authHeader) {
            return new Response(
                JSON.stringify({ success: false, error: "Missing Authorization header" }),
                { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        // ✅ 2. 创建 Supabase client（带用户 JWT）
        const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
            global: {
                headers: {
                    Authorization: authHeader,
                },
            },
        });

        // ✅ 3. 校验用户
        const {
            data: { user },
            error: authError,
        } = await supabase.auth.getUser();

        if (authError || !user) {
            return new Response(
                JSON.stringify({ success: false, error: "Unauthorized" }),
                { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        // 👉 到这里说明：用户已登录
        console.info("当前用户:", user.id);

        const body = await req.json().catch(() => ({}));

        const rawText = body?.text || "";

        const text = rawText
            .replace(/\s+/g, " ")
            .replace(/[^\S\r\n]+/g, " ")
            .trim();

        const resp = await fetch("https://aihubmix.com/v1/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${AIHUBMIX_API_KEY}`,
            },
            body: JSON.stringify({
                model: "coding-minimax-m2.5-free",
                temperature: 0,
                stream: false,
                messages: [
                    {
                        role: "system",
                        content: `你是一个基金文本解析助手。请从提供的OCR文本中执行以下任务：抽取所有基金信息，包括：基金名称：中文字符串（可含英文或括号），名称后常跟随金额数字。基金代码：6位数字（如果存在）。持有金额：数字格式（可能含千分位逗号或小数，如果存在）。持有收益：数字格式（可能含千分位逗号或小数，如果存在）。忽略无关文本。输出格式：以JSON数组形式返回结果，每个基金信息为一个对象，包含以下字段：- fundName（必填，字符串）fundCode（可选，字符串，不存在时为空字符串）- holdAmounts（可选，字符串，不存在时为空字符串）- holdGains（可选，字符串，不存在时为空字符串）除了JSON结果外，不要输出任何多余内容。`
                    },
                    {
                        role: "user",
                        content: text || "无有效OCR文本"
                    }
                ],
            }),
        });

        const result = await resp.json();

        const rawContent = result?.choices?.[0]?.message?.content || "";

        const cleaned = cleanModelOutput(rawContent);
        const parsed = extractJSON(cleaned);

        if (!parsed) {
            return new Response(
                JSON.stringify({
                    success: false,
                    error: "模型未返回合法 JSON",
                    raw: rawContent
                }),
                { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        if (!Array.isArray(parsed)) {
            return new Response(
                JSON.stringify({
                    success: false,
                    error: "返回结果不是数组",
                    data: parsed
                }),
                { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        const safeData = parsed.map((item: any) => ({
            fundName: String(item?.fundName || ""),
            fundCode: String(item?.fundCode || ""),
            holdAmounts: String(item?.holdAmounts || ""),
            holdGains: String(item?.holdGains || "")
        }));

        return new Response(
            JSON.stringify({
                success: true,
                data: safeData,
                userId: user.id // ✅ 可选：返回当前用户
            }),
            {
                status: 200,
                headers: {
                    ...corsHeaders,
                    "Content-Type": "application/json",
                }
            }
        );

    } catch (err) {
        return new Response(
            JSON.stringify({
                success: false,
                error: err.message || "Unknown error"
            }),
            { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    }
});