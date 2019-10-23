import {
  Resolver,
  Query,
  Mutation,
  Arg,
  ObjectType,
  Field,
  Ctx,
  UseMiddleware,
  Int
} from "type-graphql";
import { hash, compare } from "bcryptjs";
import { User } from "../entity/User";
import {
  createAccessToken,
  createRefreshToken
} from "../services/auth/createTokens";
import { MyContext } from "../services/context";
import { sendRefreshToken } from "../services/auth/sendRefreshToken";
import { isAuth } from "../services/auth/isAuth";
import { createOAuth2Client } from "../services/google_oauth";
import { verify } from "../services/google_oauth";
import { getConnection } from "typeorm";
import { transporter } from "../services/mailer/transporter";
import { redis } from "../services/redis";
import { verificationEmail } from "../services/mailer/verificationEmail";

@ObjectType()
class LoginResponse {
  @Field()
  accessToken: string;
  @Field(() => User)
  user: User;
}

@Resolver()
export class UserResolver {
  @Query(() => User)
  @UseMiddleware(isAuth)
  async me(@Ctx() { payload }: MyContext) {
    try {
      return await User.findOne(payload!.userId);
    } catch (err) {
      console.log(err);
      return null;
    }
  }

  @Query(() => String)
  async login_googleOAuth() {
    const client = await createOAuth2Client();

    const scopes = ["openid", "email"];

    const url = client.generateAuthUrl({
      access_type: "offline",
      scope: scopes
    });

    return url;
  }

  @Mutation(() => String)
  async sendVerificationLink(
    @Arg("email") email: string,
    @Arg("password") password: string
  ) {
    try {
      const user = await User.findOne({ email })
      if (user) {
        throw new Error("This email is already in use")
      }
      const verificationLink = await hash(email, 10);
      const hashedPassword = await hash(password, 12);

      await redis.hmset(email, { password: hashedPassword, verificationLink })
      redis.expire(email, 3600)

      transporter.sendMail(verificationEmail(email, verificationLink));
      return verificationLink;
    } catch (err) {
      console.log(err);
      return err;
    }
  }

  @Mutation(() => String)
  async resendVerificationLink(
    @Arg("email") email: string
  ) {
    try {
      const { password, verificationLink } = await redis.hgetall(email)
      const newVerificationLink = await hash(verificationLink, 10)

      await redis.hmset(email, { password, verificationLink: newVerificationLink })
      redis.expire(email, 3600)

      transporter.sendMail(verificationEmail(email, newVerificationLink))
      return newVerificationLink
    } catch (err) {
      console.log(err)
      return err
    }
  }

  @Mutation(() => LoginResponse)
  async register(
    @Arg("email") email: string,
    @Arg("verificationLink") verificationLink: string,
    @Ctx() { res }: MyContext
  ) {
    try {
      const { verificationLink: storedLink, password } = await redis.hgetall(email)
      if (verificationLink !== storedLink) {
        throw new Error('This link has expired')
      }

      const user = await User.create({
        email,
        password
      }).save();
      redis.del(email)
      
      sendRefreshToken(res, createRefreshToken(user))

      return {
        accessToken: createAccessToken(user),
        user
      };
    } catch (err) {
      console.log(err)
      return err
    }
  }

  @Mutation(() => LoginResponse)
  async login(
    @Arg("email") email: string,
    @Arg("password") password: string,
    @Ctx() { res }: MyContext
  ) {
    try {
      const user = await User.findOne({ email });

      if (!user) {
        throw new Error("Could not find user");
      }

      if (!user.validated) {
        throw new Error('This account has not been validated')
      }

      // if user's password from db is NULL
      if (!user.password) {
        throw new Error(
          `This account doesn't have a password set. Do you normally login with google?`
        );
      }

      const valid = await compare(password, user.password);

      if (!valid) {
        throw new Error("Incorrect password");
      }

      // login succesful

      // send refreshToken thru cookie
      sendRefreshToken(res, createRefreshToken(user));

      // send accessToken to client
      return {
        accessToken: createAccessToken(user),
        user
      };
    } catch (err) {
      console.log(err);
      return err;
    }
  }

  @Mutation(() => Boolean)
  async logout(@Ctx() { res }: MyContext) {
    // send empty string for refreshtoken
    sendRefreshToken(res, "");
    return true;
  }

  @Mutation(() => LoginResponse)
  //TODO: Better mutation naming
  async auth_googleOAuth(@Arg("code") code: string, @Ctx() { res }: MyContext) {
    try {
      const client = await createOAuth2Client();

      if (!client) {
        throw new Error("Failed to create OAuth2 client");
      }
      const { tokens } = await client.getToken(decodeURIComponent(code));

      if (!tokens) {
        throw new Error("Invalid code for tokens");
      }
      const payload = await verify(tokens.id_token!);

      if (!payload) {
        throw new Error("Failed to retrieve payload");
      }
      let user = await User.findOne({ email: payload.email });

      if (!user) {
        // register user to db if they don't exist in system
        user = await User.create({ email: payload.email }).save();

        if (!user) {
          throw new Error("Failed to create user");
        }
      }

      sendRefreshToken(res, createRefreshToken(user));

      return {
        accessToken: createAccessToken(user),
        user
      };
    } catch (err) {
      console.log("err", err);
      return err;
    }
  }

  @Mutation(() => Boolean)
  async revokeRefreshToken(@Arg("userId", () => Int) userId: number) {
    await getConnection()
      .getRepository(User)
      .increment({ id: userId }, "tokenVersion", 1);
    return true;
  }
}
