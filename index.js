import edgeChromium from 'chrome-aws-lambda'
import puppeteer from 'puppeteer-core'
const express = require('express'); // 引入 Express 框架
const port = 3003; // 设置服务器监听端口
const url = 'https://fireflycard.shushiai.com/'; // 要访问的目标 URL
const scale = 2; // 设置截图的缩放比例，图片不清晰就加大这个数值
const maxRetries = 3; // 设置请求重试次数
const app = express(); // 创建 Express 应用
app.use(express.json()); // 使用 JSON 中间件
app.use(express.urlencoded({extended: false})); // 使用 URL 编码中间件

const LOCAL_CHROME_EXECUTABLE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

let browser;

app.listen(port, async () => {
  console.log(`监听端口 ${port}...`);
  await goScreenShot();
});

async function goScreenShot() {
  const executablePath = await edgeChromium.executablePath || LOCAL_CHROME_EXECUTABLE

  browser = await puppeteer.launch({
    executablePath,
    args: edgeChromium.args,
    headless: false,
  })
}

// 添加默认的GET入口，输出“你好”
app.get('/', (req, res) => {
  res.send('你好');
});

// 处理保存图片的 POST 请求
app.post('/saveImg', async (req, res) => {
  let attempts = 0;
  while (attempts < maxRetries) {
      try {
          const buffer = await processRequest(req); // 处理请求
          res.setHeader('Content-Type', 'image/png'); // 设置响应头
          res.status(200).send(buffer); // 发送响应
          return;
      } catch (error) {
          console.error(`第 ${attempts + 1} 次尝试失败:`, error);
          attempts++;
          if (attempts >= maxRetries) {
              res.status(500).send(`处理请求失败，已重试 ${maxRetries} 次`); // 发送错误响应
          } else {
              await delay(1000); // 等待一秒后重试
          }
      }
  }
});

// 处理请求的主要逻辑
async function processRequest(req) {
  const body = req.body; // 获取请求体

  console.log('处理请求，内容为:', JSON.stringify(body));
  let iconSrc = body.icon;
  // 是否使用字体
  let useLoadingFont = body.useLoadingFont;
  let params = new URLSearchParams(); // 初始化 URL 查询参数
  params.append("isApi","true")
  let blackArr = ['icon', 'switchConfig', 'content', 'translate']; // 定义不需要加入查询参数的键

  for (const key in body) {
      if (!blackArr.includes(key)) {
          params.append(key, body[key]); // 添加其他参数
      } else if (key === 'switchConfig') {
          params.append(key, JSON.stringify(body[key])); // 序列化 switchConfig
      }
  }

  const result = await browser.execute({
      url: url + '?' + params.toString(), // 拼接 URL 和查询参数
      body,
      iconSrc,
  }, async ({page, data}) => {
      const {url, body, iconSrc} = data;
      await page.setRequestInterception(true); // 设置请求拦截
      page.on('request', req => {
          if (!useLoadingFont && req.resourceType() === 'font') {
              req.abort(); // 拦截字体请求
          } else {
              req.continue(); // 继续其他请求
          }
      });

      const viewPortConfig = {width: 1920, height: 1080+200}; // 设置视口配置
      await page.setViewport(viewPortConfig); // 应用视口配置
      console.log('视口设置为:', viewPortConfig);

      await page.goto(url, {
          timeout: 60000, // 设置导航超时
          waitUntil: ['load', 'networkidle2'] // 等待页面加载完成
      });
      console.log('页面已导航至:', url);

      // 等待字体加载完成
      if (useLoadingFont) {
          await page.waitForFunction('document.fonts.status === "loaded"');
      }

      // 这里因为字体是按需加载，所以前面的等待字体加载不太有效，这里增大等待时间，以免部分字体没有加载完成
      await delay(3000)

      // 查找卡片元素
      const cardElement = await page.$(`.${body.temp || 'tempA'}`);
      if (!cardElement) {
          throw new Error('请求的卡片不存在'); // 抛出错误
      }
      console.log('找到卡片元素');

      let translate = body.translate;
      if (translate) {
          await page.evaluate((translate) => {
              // 如果有英文翻译插入英文翻译
              const translateEl = document.querySelector('[name="showTranslation"]');
              if (translateEl) translateEl.innerHTML = translate;
          }, translate);
      }

      let content = body.content;
      let isContentHtml = body.isContentHtml;
      if (content) {
          let html = content;
           if (!isContentHtml) {
               content = content.replace(/\n\n/g, '--br----br--');
              html = md.render(content);
              html = html.replace(/--br--/g, '<br/>').replace(/\t/g, '&nbsp;&nbsp;&nbsp;&nbsp;');
          }
          await page.evaluate(html => {
              // 插入内容
              const contentEl = document.querySelector('[name="showContent"]');
              if (contentEl) contentEl.innerHTML = html;
          }, html);
          console.log('卡片内容已设置');
      }

      if (iconSrc && iconSrc.startsWith('http')) {
          await page.evaluate(function(imgSrc) {
              return new Promise(function(resolve) {
                  var imageElement = document.querySelector('#icon');
                  console.log("头像", imageElement);
                  if (imageElement) {
                      imageElement.src = imgSrc;
                      imageElement.addEventListener('load', function() { resolve(true); });
                      imageElement.addEventListener('error', function() { resolve(true); });
                  } else {
                      resolve(false);
                  }
              });
          }, iconSrc);
          console.log('图标已设置');
      }

      const boundingBox = await cardElement.boundingBox(); // 获取卡片元素边界框
      if (boundingBox.height > viewPortConfig.height) {
          await page.setViewport({width: 1920, height: Math.ceil(boundingBox.height)+200}); // 调整视口高度
      }
      console.log('找到边界框并调整视口');
      let imgScale = body.imgScale ? body.imgScale: scale;
      console.log('图片缩放比例为:', imgScale)
      const buffer = await page.screenshot({
          type: 'png', // 设置截图格式为 PNG
          clip: {
              x: boundingBox.x,
              y: boundingBox.y,
              width: boundingBox.width,
              height: boundingBox.height,
              scale: imgScale // 设置截图缩放比例
          },
          timeout: 60000, // 设置截图超时
      });
      console.log('截图已捕获');

      return buffer; // 返回截图
  });

  return result; // 返回处理结果
}

// 延迟函数，用于等待指定的毫秒数
function delay(timeout) {
  return new Promise(resolve => setTimeout(resolve, timeout));
}
