import { useState } from "react";
import { Form, required, useLogin, useNotify } from "ra-core";
import type { SubmitHandler, FieldValues } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { TextInput } from "@/components/admin/text-input";
import { Notification } from "@/components/admin/notification";

/**
 * Login page displayed when authentication is enabled and the user is not authenticated.
 *
 * Automatically shown when an unauthenticated user tries to access a protected route.
 * Handles login via authProvider.login() and displays error notifications on failure.
 *
 * @see {@link https://marmelab.com/shadcn-admin-kit/docs/loginpage LoginPage documentation}
 * @see {@link https://marmelab.com/shadcn-admin-kit/docs/security Security documentation}
 */
export const LoginPage = (props: { redirectTo?: string }) => {
  const { redirectTo } = props;
  const [loading, setLoading] = useState(false);
  const login = useLogin();
  const notify = useNotify();

  const handleSubmit: SubmitHandler<FieldValues> = (values) => {
    setLoading(true);
    login(values, redirectTo)
      .then(() => {
        setLoading(false);
      })
      .catch((error) => {
        setLoading(false);
        notify(
          typeof error === "string"
            ? error
            : typeof error === "undefined" || !error.message
              ? "ra.auth.sign_in_error"
              : error.message,
          {
            type: "error",
            messageArgs: {
              _:
                typeof error === "string"
                  ? error
                  : error && error.message
                    ? error.message
                    : undefined,
            },
          },
        );
      });
  };

  return (
    <div className="min-h-screen flex">
      <div className="container relative grid flex-col items-center justify-center sm:max-w-none lg:grid-cols-2 lg:px-0">
        <div className="relative hidden h-full flex-col bg-muted p-10 text-white dark:border-r lg:flex">
          <div className="absolute inset-0 bg-zinc-900" />
          <div className="relative z-20 flex items-center text-lg font-medium">
            m-tunnel
          </div>
          <div className="relative z-20 mt-auto">
            <blockquote className="space-y-2">
              <p className="text-lg">
                连接网页 AI 与你的 VS Code 工作区。
              </p>
              <footer className="text-sm">工作区 · 成员权限 · MCP Token</footer>
            </blockquote>
          </div>
        </div>
        <div className="p-6 lg:p-8">
          <div className="mx-auto flex w-full flex-col justify-center space-y-6 sm:w-[350px]">
            <div className="flex flex-col space-y-2 text-center">
              <h1 className="text-2xl font-semibold tracking-tight">登录管理台</h1>
              <p className="text-sm leading-none text-muted-foreground">
                使用你的账号登录管理台
              </p>
            </div>
            <Form className="space-y-8" onSubmit={handleSubmit}>
              <TextInput
                label="邮箱"
                source="email"
                type="email"
                validate={required()}
              />
              <TextInput
                label="密码"
                source="password"
                type="password"
                validate={required()}
              />
              <Button
                type="submit"
                className="cursor-pointer"
                disabled={loading}
              >
                登录管理台
              </Button>
            </Form>
          </div>
        </div>
      </div>
      <Notification />
    </div>
  );
};
