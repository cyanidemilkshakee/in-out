<#if client?? && client.baseUrl?has_content>
<#assign appLoginUrl = client.baseUrl + "/login?error=identity_provider_failure">
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta http-equiv="refresh" content="0;url=${appLoginUrl}">
    <meta name="robots" content="noindex,nofollow">
    <title>Returning to InOut</title>
  </head>
  <body>
    <p>Returning to InOut sign-in.</p>
    <a href="${appLoginUrl}">Continue to InOut</a>
  </body>
</html>
<#else>
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="robots" content="noindex,nofollow">
    <title>Return to InOut</title>
  </head>
  <body>
    <p>Sign-in could not continue. Return to the InOut sign-in page.</p>
  </body>
</html>
</#if>
