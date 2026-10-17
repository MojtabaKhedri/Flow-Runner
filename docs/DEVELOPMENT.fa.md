<div dir="rtl" align="right">

<h1 dir="rtl">راهنمای توسعهٔ <span dir="ltr">Flow Runner</span></h1>

<h2 dir="rtl">ساخت از سورس</h2>

<p dir="rtl">برای ساخت پروژه به <span dir="ltr">Node.js</span> <strong>نسخهٔ ۲۲ یا جدیدتر</strong> نیاز داری. فرمان‌های زیر را به‌ترتیب اجرا کن:</p>

</div>

<div dir="ltr" align="left">

```sh
git clone https://github.com/MojtabaKhedri/Flow-Runner.git
cd Flow-Runner
npm ci --ignore-scripts --no-fund --no-audit
npm run verify
```

</div>

<div dir="rtl" align="right">

<p dir="rtl">اگر در محیط <span dir="ltr">PowerShell</span> اجرای فرمان <code dir="ltr">npm</code> مسدود بود، از <code dir="ltr">npm.cmd</code> استفاده کن. پس از ساخت، پوشهٔ <code dir="ltr">dist</code> را در مرورگر بارگذاری کن. فایل فشردهٔ آماده هم در پوشهٔ <code dir="ltr">release</code> ساخته می‌شود. نام پوشهٔ پروژه محدودیتی ندارد.</p>

<p dir="rtl">فرمان <code dir="ltr">verify</code> ساخت، آزمون‌ها، بررسی مجوزها و فایل‌های بسته و سپس بسته‌بندی را انجام می‌دهد. کد در پوشهٔ <code dir="ltr">src</code>، رابط و فونت در <code dir="ltr">public</code> و آزمون‌ها در <code dir="ltr">tests</code> هستند. پوشه‌های خروجی <code dir="ltr">dist</code> و <code dir="ltr">release</code> و وابستگی‌های <code dir="ltr">node_modules</code> در مخزن نگهداری نمی‌شوند.</p>

<p dir="rtl">برای نسخهٔ ۱.۰.۱، تعداد ۵۲ آزمون خودکار با داده‌های ساختگی وجود دارد. این آزمون‌ها جای تست با حساب واقعی، تضمین سلامت حساب یا تأیید فروشگاه را نمی‌گیرند.</p>

</div>
