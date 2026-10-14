# الهلال AI — النشر على Render

1. ارفع محتويات هذا المجلد على GitHub (في جذر المستودع مباشرة: `server.mjs` و`index.html` و`package.json` و`render.yaml`).
2. في Render: New ← Blueprint ← اختر المستودع. يقرأ `render.yaml` تلقائيًا.
3. أضف المتغيرات في Environment: LTX_API_KEY, GEMINI_API_KEY, XKIRO_API_KEY, ADMIN_PHONE, ADMIN_INITIAL_PASSWORD
   + متغيرات Firebase (FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, FIREBASE_WEB_API_KEY, FIREBASE_AUTH_DOMAIN, FIREBASE_APP_ID).
4. بعد النشر افتح `/api/health` وتأكد إنه يرجع ok:true.

ملاحظات:
- بدون Firebase البيانات بتتحفظ في ملفات محلية وتضيع عند كل إعادة نشر (الخطة المجانية). فعّل Firebase للتخزين الدائم.
- لا ترفع ملف .env إلى GitHub.
- لا تستخدم Vercel لهذا المشروع: السيرفر دائم التشغيل.
