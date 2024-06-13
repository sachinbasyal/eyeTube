import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/ApiError.js";
import { User } from "../models/user.model.js";
import { uploadOnCloudinary } from "../utils/fileHandling.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import jwt from "jsonwebtoken";
import fs from "fs";

const generateRefreshAndAccessTokens = async (userId) => {
  try {
    const user = await User.findById(userId);
    const accessToken = user.generateAccessToken();
    const refreshToken = user.generateRefreshToken();

    user.refreshToken = refreshToken;
    await user.save({ validateBeforeSave: false });

    return { accessToken, refreshToken };
  } catch (error) {
    throw new ApiError(
      500,
      "Something went wrong while generating Refresh /Access Tokens"
    );
  }
};

// User registration
const registerUser = asyncHandler(async (req, res) => {
  /*  Steps:
  1. get user details from frontend (req)
  2. validation (!empty)
  3. check if user already exists: username / email
  4. check for userImages and avatar
  5. upload the images to cloudinary, check avatar
  6. create user object - create entry in db
  7. remove the password and refresh token fields from the response
  8. check for user creation
  9. return with response
*/
  const eraseTempFile = () => {
    try {
      fs.unlinkSync(req.files.avatar[0].path);
      fs.unlinkSync(req.files.coverImage[0].path);
    } catch (err) {
      //console.error(err.message);
      console.log("File(s) deleted from the temp folder!");
    }
  };

  const { username, fullname, password, email } = req.body;
  // console.log(username); // check in console if the raw data is retrieved..

  // check if the fields are empty
  if (
    [username, fullname, password, email].some((field) => field?.trim() === "")
  ) {
    eraseTempFile();
    throw new ApiError(400, "All fields are required");
  }

  const existedUser = await User.findOne({
    $or: [{ username }, { email }],
  }); // findOne() will send the very first matched-data from the db table

  if (existedUser) {
    eraseTempFile();
    throw new ApiError(409, "User with username or email already exists");
  }

  // console.log(req.files)
  const avatarLocalPath = req.files?.avatar[0]?.path;
  const coverImageLocalPath = req.files?.coverImage?.[0]?.path; // ensure coverImage exists before trying to access its index
  /* alternative - classic style
  let coverImageLocalPath;
  if (
    req.files &&
    Array.isArray(req.files.coverImage) &&
    req.files.coverImage.length > 0
  ) {
    coverImageLocalPath = req.files.coverImage[0].path;
  } // coverImage is optional */

  if (!avatarLocalPath) {
    throw new ApiError(400, "Avatar path is missing");
  }

  const avatar = await uploadOnCloudinary(avatarLocalPath);
  const coverImage = await uploadOnCloudinary(coverImageLocalPath);
  // console.log(avatar)

  if (!avatar) {
    throw new ApiError(400, "Avatar is required");
  }

  const user = await User.create({
    fullname,
    avatar: avatar.secure_url,
    coverImage: coverImage?.secure_url || "",
    password,
    email,
    username: username.toLowerCase(),
  });

  const createdUser = await User.findById(user._id).select(
    "-password -refreshToken"
  ); // check if the user is created and remove the password and refresh token fields for response

  if (!createdUser) {
    throw new ApiError(
      500,
      "Something went wrong with the server while registering a user"
    );
  }

  return res
    .status(201)
    .json(new ApiResponse(200, createdUser, "User registered successfully"));
});

// User login
const loginUser = asyncHandler(async (req, res) => {
  /* Steps:
  1. get user details from req body
  2. check username &/or email
  3. find the user
  4. check for the valid password
  5. generate access and refresh tokens
  6. send the tokens via secured cookies
  7. return with response
 */

  const { username, password, email } = req.body;

  // if (!username && !email) {
  //   throw new ApiError(400, "username and email are required");
  // }
  if (!(username || email)) {
    throw new ApiError(400, "username or email is required");
  }

  const existedUser = await User.findOne({
    $or: [{ username }, { email }],
  });

  if (!existedUser) {
    throw new ApiError(404, "User does not exists!");
  }

  const isPasswordValid = await existedUser.isPasswordCorrect(password);

  if (!isPasswordValid) {
    throw new ApiError(401, "Invalid user credentials!");
  }

  const { accessToken, refreshToken } = await generateRefreshAndAccessTokens(
    existedUser._id
  );

  //const loggedInUser = existedUser.select("-password -refreshToken")

  const loggedInUser = await User.findById(existedUser._id).select(
    "-password -refreshToken"
  ); // if DB query is not too much of concern!

  const options = {
    httpOnly: true,
    secure: true,
  }; // here, cookie can't be modified in frontend and can only be modified by server

  return res
    .status(200)
    .cookie("accessToken", accessToken, options)
    .cookie("refreshToken", refreshToken, options)
    .json(
      new ApiResponse(
        200,
        { user: loggedInUser, accessToken, refreshToken },
        "User logged in successfully"
      )
    );
});

// user logout
const logoutUser = asyncHandler(async (req, res) => {
  await User.findByIdAndUpdate(
    req.user._id,
    {
      $set: {
        refreshToken: undefined,
      },
    },
    {
      new: true,
    }
  );

  const options = {
    httpOnly: true,
    secure: true,
  };

  return res
    .status(200)
    .clearCookie("accessToken", options)
    .clearCookie("refreshToken", options)
    .json(new ApiResponse(200, {}, "User logged out successfully"));
});

// handle Refresh Access Token endpoint
const refreshAccessToken = asyncHandler(async (req, res) => {
  
  const incomingRefreshToken =
    req.cookies.refreshToken || req.body.refreshToken; // req.body: ~from mobile apps

  if (!incomingRefreshToken) {
    throw new ApiError(401, "Unauthorized request!");
  }

  try {
    const decodedToken = jwt.verify(
      incomingRefreshToken,
      process.env.REFRESH_TOKEN_SECRET
    );

    const user = await User.findById(decodedToken?._id);

    if (!user) {
      throw new ApiError(401, "Invalid Refresh Token!");
    }

    if (user?.refreshToken !== incomingRefreshToken) {
      throw new ApiError(
        401,
        "Refresh Token is either expired or already used!"
      );
    }

    const { accessToken, refreshToken } =
      await generateRefreshAndAccessTokens(user._id);

    const options = {
      httpOnly: true,
      secure: true
    };

    return res
      .status(200)
      .cookie("accessToken", accessToken, options)
      .cookie("refreshToken", refreshToken, options)
      .json(
        new ApiResponse(
          200,
          { accessToken, refreshToken },
          "Access Token refreshed"
        )
      );
  } catch (error) {
    throw new ApiError(401, error?.message || "Invalid Refresh Token");
  }
});

// change password
const changeCurrentPassword = asyncHandler(async (req,res)=>{

  const {oldPassword, newPassword, confirmPassword} = req.body

  if (!(newPassword===confirmPassword)) {
    throw new ApiError(401, "Please check if the new and confirm passwords are matched")
  }
  
  const user = await User.findById(req.user?._id)
  const isPasswordCorrect = await user.isPasswordCorrect(oldPassword)

  if(!isPasswordCorrect) {
    throw new ApiError(400, "Invalid password")
  }

  user.password = newPassword;
  await user.save({validateBeforeSave: false});

  return res
  .status(200)
  .json(new ApiResponse(200, {}, "Password is changed successfully!"))

})

export { registerUser, loginUser, logoutUser, refreshAccessToken, changeCurrentPassword };
