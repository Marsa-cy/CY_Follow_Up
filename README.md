# 🚢 Marsa — Container Search & Yard Management System

<p align="center">
  <img src="icon-192.png" alt="Marsa Logo" width="120">
</p>

<p align="center">
  <strong>نظام متكامل لإدارة الحاويات والفناء — Container Lookup & Yard Operations</strong>
</p>

<p align="center">
  <a href="#features">الميزات</a> •
  <a href="#installation">التثبيت</a> •
  <a href="#usage">الاستخدام</a> •
  <a href="#security">الأمان</a> •
  <a href="#contributing">المساهمة</a>
</p>

---

## 📋 نظرة عامة

**Marsa** هو تطبيق ويب تقدمي (PWA) متكامل لإدارة عمليات الحاويات والفناء. يعمل بالكامل دون الحاجة إلى خادم (Serverless)، ويمكن تشغيله من ملف HTML واحد أو تثبيته كتطبيق على الجوال.

### ✨ المميزات الرئيسية

| الميزة | الوصف |
|--------|-------|
| 🔍 **بحث متقدم** | بحث فردي وجماعي عن الحاويات عبر رقم الحاوية، الختم، العميل، الناقل |
| 🏗️ **إدارة الفناء** | خريطة تفاعلية للـ Stacks والبايز مع تسجيل الحركات |
| 📊 **تقارير متكاملة** | تصدير Excel وPDF مع تنبيهات المواعيد النهائية |
| ☁️ **مزامنة سحابية** | Firebase Firestore للمزامنة بين الأجهزة (اختياري) |
| 👥 **إدارة المستخدمين** | نظام أذونات متدرج (Controller, Yard Op, Export, Upload) |
| 🌙 **وضع داكن** | دعم كامل للوضع الداكن والفاتح |
| 🌍 **متعدد اللغات** | العربية (RTL)، الإنجليزية، الكورية |
| 📱 **PWA** | يعمل offline ويمكن تثبيته على الجوال |

---

## 🚀 التثبيت

### الطريقة 1: الاستخدام المباشر (أسرع)

```bash
# 1. نسخ المستودع
git clone https://github.com/your-org/marsa-system.git
cd marsa-system

# 2. فتح الملف مباشرة
# فقط افتح index.html في المتصفح — لا يحتاج بناء!
```

### الطريقة 2: مع Firebase (للمزامنة السحابية)

```bash
# 1. نسخ المستودع
git clone https://github.com/your-org/marsa-system.git
cd marsa-system

# 2. نسخ ملف الإعدادات
cp .env.example .env

# 3. تعديل .env بمفاتيح Firebase الخاصة بك
# احصل عليها من: https://console.firebase.google.com

# 4. فتح index.html في المتصفح
```

### متطلبات النظام

| المتطلب | الحد الأدنى |
|---------|------------|
| المتصفح | Chrome 90+, Firefox 88+, Safari 14+, Edge 90+ |
| التخزين | 50 MB متاح |
| الإنترنت | غير مطلوب (اختياري للمزامنة) |

---

## 📖 دليل الاستخدام

### تسجيل الدخول

1. افتح التطبيق في المتصفح
2. أدخل اسم المستخدم وكلمة المرور
3. الحساب الافتراضي للـ Controller:
   - **Username:** `admin`
   - **Password:** (يتم إنشاؤه عند أول استخدام)

### البحث عن حاوية

1. أدخل رقم الحاوية في حقل البحث
2. اضغط Enter أو زر البحث
3. ستظهر بطاقة الهوية مع كل البيانات

### إدارة الفناء

1. اضغط على زر 🏗️ Yard في الشريط العلوي
2. اختر تبويب "Log a Move" لتسجيل حركة
3. اختر تبويب "Map" لرؤية خريطة الفناء

### تصدير التقارير

1. بعد البحث، اضغط على "Excel" أو "PDF"
2. للبحث المتعدد، استخدم "Multi-Search"
3. تقارير الفناء متاحة من نافذة Yard

---

## 🔐 الأمان

### ميزات الأمان المدمجة

- ✅ **PBKDF2 Hashing** لتجزئة كلمات المرور
- ✅ **Content Security Policy (CSP)** لمنع XSS
- ✅ **Permission Gating** — إخفاء العناصر وليس فقط تعطيلها
- ✅ **Session Timeout** — تسجيل خروج تلقائي
- ✅ **Audit Logging** — سجل كل العمليات
- ✅ **Firebase Auth** — مصادقة حقيقية (اختياري)

### أفضل الممارسات

```bash
# 1. NEVER commit .env
echo ".env" >> .gitignore

# 2. Use Firebase Security Rules
# قواعد Firestore الموصى بها في docs/firestore-rules.md

# 3. Regular backups
# استخدم زر "Download Full Backup" في إدارة المستخدمين
```

---

## 🏗️ بناء المشروع

### هيكل الملفات

```
marsa-system/
├── index.html          # الصفحة الرئيسية (الهيكل)
├── styles.css          # أنماط CSS
├── app.js              # منطق التطبيق
├── manifest.json       # إعدادات PWA
├── .env.example        # نموذج الإعدادات
├── smoke-test.js       # اختبارات Smoke
├── icon-192.png        # أيقونة التطبيق
├── icon-512.png        # أيقونة كبيرة
└── docs/
    ├── firestore-rules.md
    ├── user-guide.md
    └── api-reference.md
```

### التقنيات المستخدمة

| التقنية | الاستخدام |
|---------|----------|
| Vanilla JS | منطق التطبيق (لا إطارات!) |
| CSS Custom Properties | التصميم المتجاوب |
| Firebase | المزامنة السحابية (اختياري) |
| SheetJS | قراءة Excel |
| jsPDF | توليد PDF |
| Pako | ضغط البيانات |

---

## 🧪 الاختبارات

```bash
# تشغيل اختبارات Smoke
node smoke-test.js index.html

# النتيجة المتوقعة
# ✅ 19 passed, 0 failed
```

### الاختبارات المشمولة

| الوظيفة | الحالات |
|---------|--------|
| `detentionInfo` | حساب أيام الاحتجاز |
| `iso6346CheckDigitValid` | التحقق من رقم الحاوية |
| `normalizeContainer` | توحيد تنسيق الرقم |
| `currentStatus` | تحديد الحالة |
| `yardLocationDisabled` | التحقق من المواقع المعطلة |

---

## 🤝 المساهمة

نرحب بمساهماتكم! للمساهمة:

1. Fork المستودع
2. أنشئ فرعاً جديداً (`git checkout -b feature/amazing-feature`)
3. Commit التغييرات (`git commit -m 'Add amazing feature'`)
4. Push إلى الفرع (`git push origin feature/amazing-feature`)
5. افتح Pull Request

### معايير الكود

- ✅ صفر أخطاء في smoke tests
- ✅ دعم RTL للعربية
- ✅ تعليقات واضحة للكود المعقد
- ✅ لا console.logs في الإنتاج

---

## 📄 الترخيص

هذا المشروع مرخص بموجب [MIT License](LICENSE).

**مجاني بالكامل** للاستخدام الشخصي والتجاري.

---

## 🙏 الاعترافات

- خطوط Google Fonts (Inter, JetBrains Mono)
- Firebase (Google)
- SheetJS Community
- jsPDF Contributors

---

<p align="center">
  <strong>Made with ❤️ for the logistics community</strong>
</p>
